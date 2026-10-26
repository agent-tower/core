import { compactWhitespace, truncateWithEllipsis, buildTextPreview } from '../utils/text-preview.js';
export { buildTextPreview } from '../utils/text-preview.js';
import { prisma } from '../utils/index.js';
import { TaskStatus, SessionStatus, SessionPurpose, WorkspaceKind, WorkspaceStatus } from '../types/index.js';
import { getWorkspaceWorkingDir } from './workspace-kind.js';
import {
  NotFoundError,
  ServiceError,
  ValidationError,
  InvalidStateTransitionError,
} from '../errors.js';
import type { EventBus } from '../core/event-bus.js';
import type { SessionManager } from './session-manager.js';
import type { TaskCleanupService, TaskCleanupSnapshot } from './task-cleanup.service.js';
import type { WorkspaceBackgroundService } from './workspace-background-service.service.js';
import { defaultWorkspaceLifecycleBarrier } from './workspace-lifecycle-barrier.js';
import { ensureProjectIsMutable, getStoredProjectGitCapability, detectProjectGitCapability } from './project-guards.js';
import { requireLocalBaseBranch } from '../git/base-branch.js';
import { defaultTeamLockService } from './team-lock.service.js';
import type { CreateTaskInput, TaskBoardItem, TaskBoardResponse } from '@agent-tower/shared';
import { TaskPriority } from '@agent-tower/shared';
import prismaPkg from '@prisma/client';

const { Prisma } = prismaPkg;

const taskBoardColumns = Prisma.sql`
  task."id", task."projectId", task."title", task."status", task."priority",
  task."position", task."updatedAt", task."parentTaskId",
  (SELECT COUNT(*) FROM "Task" child WHERE child."parentTaskId" = task."id" AND child."deletedAt" IS NULL) AS "subtaskCount",
  (SELECT COUNT(*) FROM "Task" child WHERE child."parentTaskId" = task."id" AND child."deletedAt" IS NULL AND child."status" = 'IN_PROGRESS') AS "runningSubtaskCount"
`;


interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: number;
}

interface FindTasksParams {
  projectId?: string;
  parentTaskId?: string;
  status?: TaskStatus;
  page?: number;
  limit?: number;
}

/**
 * 合法的状态流转规则
 * 看板拖拽场景下允许任意状态互转，状态变更无危险副作用
 */
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TaskStatus.TODO]: [TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW, TaskStatus.DONE, TaskStatus.CANCELLED],
  [TaskStatus.IN_PROGRESS]: [TaskStatus.TODO, TaskStatus.IN_REVIEW, TaskStatus.DONE, TaskStatus.CANCELLED],
  [TaskStatus.IN_REVIEW]: [TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.DONE, TaskStatus.CANCELLED],
  [TaskStatus.DONE]: [TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW, TaskStatus.CANCELLED],
  [TaskStatus.CANCELLED]: [TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW, TaskStatus.DONE],
};
const CANCELLABLE_DELETE_WORK_REQUEST_STATUSES = ['PENDING_APPROVAL', 'QUEUED', 'STARTED'];
const CANCELLABLE_DELETE_INVOCATION_STATUSES = ['QUEUED', 'RUNNING', 'SESSION_ENDED', 'WAITING_ROOM_REPLY'];
export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_TITLE_AUTOSPLIT_THRESHOLD = 240;
export const TASK_PREVIEW_MAX_LENGTH = 240;
export const TASK_HISTORICAL_TITLE_BODY_THRESHOLD = TASK_TITLE_AUTOSPLIT_THRESHOLD;
const visibleSessionSummary = {
  where: { purpose: { not: SessionPurpose.COMMIT_MSG } },
  select: {
    id: true,
    workspaceId: true,
    agentType: true,
    variant: true,
    providerId: true,
    status: true,
    purpose: true,
    tokenUsage: true,
    createdAt: true,
    updatedAt: true,
  },
};

type TaskBoardWorkspaceRow = {
  workspaceId: string;
  taskId: string;
  workspaceStatus: string;
  workspaceKind: string;
  branchName: string;
  agentType: string | null;
  hasActiveSession: bigint | number | boolean;
};

type TaskBoardTaskRow = {
  parentTaskId: string | null;
  subtaskCount: bigint | number;
  runningSubtaskCount: bigint | number;
  id: string;
  projectId: string;
  title: string;
  status: string;
  priority: number | null;
  position: number;
  updatedAt: Date | string | number;
};

function sliceAtCompleteCodePointBoundary(value: string, maxLength: number): string {
  let end = 0;
  for (const character of value) {
    if (end + character.length > maxLength) {
      break;
    }
    end += character.length;
  }
  return value.slice(0, end);
}

function truncateWithEllipsisDetails(value: string, maxLength: number): {
  value: string;
  consumedLength: number;
} {
  if (value.length <= maxLength) {
    return { value, consumedLength: value.length };
  }

  const limit = Math.max(1, maxLength - 3);
  const sliced = sliceAtCompleteCodePointBoundary(value, limit);
  const boundary = Math.max(
    sliced.lastIndexOf(' '),
    sliced.lastIndexOf('，'),
    sliced.lastIndexOf('。'),
    sliced.lastIndexOf(','),
    sliced.lastIndexOf('.')
  );
  const candidate = (boundary >= Math.floor(limit * 0.6) ? sliced.slice(0, boundary) : sliced).trimEnd();
  return {
    value: `${candidate}...`,
    consumedLength: candidate.length,
  };
}

function normalizeTaskTitle(title: string): string {
  const normalized = compactWhitespace(title);
  if (normalized.length === 0) {
    throw new ValidationError('Task title is required');
  }
  return truncateWithEllipsis(normalized, TASK_TITLE_MAX_LENGTH);
}

function needsBodySplit(rawTitle: string, normalizedTitle: string): boolean {
  if (rawTitle.length > TASK_TITLE_AUTOSPLIT_THRESHOLD || normalizedTitle.length > TASK_TITLE_MAX_LENGTH) {
    return true;
  }

  const nonEmptyLines = rawTitle.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return nonEmptyLines.length > 1 && rawTitle.trim().length > TASK_TITLE_MAX_LENGTH;
}

function deriveTitleFromBody(rawBody: string): string {
  const firstLine = rawBody.split(/\r?\n/).map((line) => compactWhitespace(line)).find(Boolean) ?? rawBody;
  const sentenceMatch = firstLine.match(/^(.+?[。！？.!?])(?:\s|$)/u);
  const candidate = sentenceMatch?.[1] ?? firstLine;
  return normalizeTaskTitle(candidate);
}

function mergeDescriptionParts(parts: Array<string | null | undefined>): string | undefined {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const trimmed = part?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    merged.push(part!);
    seen.add(trimmed);
  }
  return merged.length > 0 ? merged.join('\n\n') : undefined;
}

function compactWhitespaceWithSourceOffsets(value: string): {
  value: string;
  sourceEndOffsets: number[];
} {
  let compacted = '';
  let sourceOffset = 0;
  let pendingWhitespaceEnd = 0;
  let hasPendingWhitespace = false;
  const sourceEndOffsets: number[] = [];

  for (const character of value) {
    sourceOffset += character.length;
    if (/\s/u.test(character)) {
      if (compacted.length > 0) {
        hasPendingWhitespace = true;
        pendingWhitespaceEnd = sourceOffset;
      }
      continue;
    }

    if (hasPendingWhitespace) {
      compacted += ' ';
      sourceEndOffsets.push(pendingWhitespaceEnd);
      hasPendingWhitespace = false;
    }
    compacted += character;
    for (let index = 0; index < character.length; index += 1) {
      sourceEndOffsets.push(sourceOffset);
    }
  }

  return { value: compacted, sourceEndOffsets };
}

function getTitleSeparatorLength(remainder: string): number {
  const lineSeparator = remainder.match(/^[ \t]*(?:\r\n|\r|\n)/u);
  if (lineSeparator) {
    return lineSeparator[0].length;
  }
  return /^[ \t]/u.test(remainder) ? 1 : 0;
}

function deriveTaskTitleBodySplit(rawBody: string): {
  title: string;
  consumedEnd: number;
  body: string;
} {
  const linePattern = /[^\r\n]+/g;
  let lineMatch: RegExpExecArray | null;

  while ((lineMatch = linePattern.exec(rawBody)) !== null) {
    const compactedLine = compactWhitespaceWithSourceOffsets(lineMatch[0]);
    if (compactedLine.value.length === 0) {
      continue;
    }

    const sentenceMatch = compactedLine.value.match(/^(.+?[。！？.!?])(?:\s|$)/u);
    const candidate = sentenceMatch?.[1] ?? compactedLine.value;
    const normalizedTitle = truncateWithEllipsisDetails(candidate, TASK_TITLE_MAX_LENGTH);
    const consumedLineEnd = compactedLine.sourceEndOffsets[normalizedTitle.consumedLength - 1] ?? 0;
    const rawConsumedEnd = lineMatch.index + consumedLineEnd;
    const remainder = rawBody.slice(rawConsumedEnd);
    const separatorLength = getTitleSeparatorLength(remainder);
    const consumedEnd = rawConsumedEnd + separatorLength;

    return {
      title: normalizedTitle.value,
      consumedEnd,
      body: rawBody.slice(consumedEnd),
    };
  }

  throw new ValidationError('Task title is required');
}

function mergeAutosplitDescription(
  body: string,
  description: string | null | undefined
): string | undefined {
  if (body.length === 0) {
    return description ?? undefined;
  }
  if (!description?.trim()) {
    return body;
  }
  return `${body}\n\n${description}`;
}

function normalizeCreateTaskInput(input: CreateTaskInput): Required<Pick<CreateTaskInput, 'title'>> & Pick<CreateTaskInput, 'description' | 'priority'> {
  const rawTitle = input.title;
  const compactTitle = compactWhitespace(rawTitle);
  if (compactTitle.length === 0) {
    throw new ValidationError('Task title is required');
  }

  if (!needsBodySplit(rawTitle, compactTitle)) {
    return {
      title: normalizeTaskTitle(rawTitle),
      description: input.description,
      priority: input.priority,
    };
  }

  const split = deriveTaskTitleBodySplit(rawTitle);
  return {
    title: split.title,
    description: mergeAutosplitDescription(split.body, input.description),
    priority: input.priority,
  };
}

function normalizeUpdateTaskInput(
  current: { description?: string | null },
  input: UpdateTaskInput
): UpdateTaskInput {
  if (input.title === undefined) {
    return input;
  }

  const rawTitle = input.title;
  const compactTitle = compactWhitespace(rawTitle);
  if (compactTitle.length === 0) {
    throw new ValidationError('Task title is required');
  }

  if (!needsBodySplit(rawTitle, compactTitle)) {
    return {
      ...input,
      title: normalizeTaskTitle(rawTitle),
    };
  }

  return {
    ...input,
    title: deriveTitleFromBody(rawTitle),
    description: mergeDescriptionParts([
      rawTitle,
      input.description,
      current.description,
    ]),
  };
}


function withTaskPreviews<T extends { title: string; description?: string | null }>(
  task: T,
  options: { omitDescription?: boolean } = {}
) {
  const titlePreview = buildTextPreview(task.title, TASK_TITLE_MAX_LENGTH);
  const contentPreview = buildTextPreview(task.description);
  const isTruncated =
    task.title !== titlePreview
    || Boolean(task.description && task.description !== contentPreview);

  const base = {
    ...task,
    title: titlePreview,
    titlePreview,
    contentPreview: contentPreview || undefined,
    isTruncated,
  };

  if (options.omitDescription) {
    const withoutDescription = { ...base };
    delete (withoutDescription as { description?: unknown }).description;
    return withoutDescription;
  }

  return base;
}

type ProjectWithStoredGitCapability = {
  repoPath: string;
  isGitRepo: boolean | null;
  worktreeReady: boolean | null;
  gitCapabilityReason: string | null;
};

function withProjectGitMetadata<T extends { project: ProjectWithStoredGitCapability }>(
  task: T
): Omit<T, 'project'> & { project: T['project'] & ReturnType<typeof getStoredProjectGitCapability> } {
  const capability = getStoredProjectGitCapability(task.project);
  return withProjectGitCapability(task, capability);
}

function withProjectGitCapability<T extends { project: ProjectWithStoredGitCapability }>(
  task: T,
  capability: ReturnType<typeof getStoredProjectGitCapability>
): Omit<T, 'project'> & { project: T['project'] & ReturnType<typeof getStoredProjectGitCapability> } {
  return {
    ...task,
    project: {
      ...task.project,
      ...capability,
    },
  };
}

function buildProjectGitMetadata(project: ProjectWithStoredGitCapability) {
  return getStoredProjectGitCapability(project);
}

function buildTaskPrompt(task: { title: string; description?: string | null }): string {
  const title = task.title.trim();
  const description = task.description;
  return description?.trim()
    ? [title, description].filter(Boolean).join('\n\n')
    : title;
}

export class TaskService {
  constructor(
    private readonly eventBus: EventBus,
    private readonly sessionManager: SessionManager,
    private readonly cleanupService: Pick<TaskCleanupService, 'trigger'> | undefined = undefined,
    private readonly backgroundService?: Pick<WorkspaceBackgroundService, 'stopAllForWorkspace'>,
  ) {}

  /**
   * Compact board read model. Query count remains fixed as project/task counts grow.
   */
  async findBoard(params: FindTasksParams = {}): Promise<TaskBoardResponse> {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(1000, Math.max(1, params.limit || 1000));
    const skip = (page - 1) * limit;
    const where = {
      deletedAt: null,
      project: { archivedAt: null },
      ...(params.projectId ? { projectId: params.projectId } : {}),
      ...(params.parentTaskId ? { parentTaskId: params.parentTaskId } : {}),
      ...(params.status ? { status: params.status } : {}),
    };

    const projectFilter = params.projectId
      ? Prisma.sql`AND task."projectId" = ${params.projectId}`
      : Prisma.empty;
    const parentFilter = params.parentTaskId
      ? Prisma.sql`AND task."parentTaskId" = ${params.parentTaskId}`
      : Prisma.empty;
    const statusFilter = params.status
      ? Prisma.sql`AND task."status" = ${params.status}`
      : Prisma.empty;

    const [tasks, total] = await Promise.all([
      prisma.$queryRaw<TaskBoardTaskRow[]>(Prisma.sql`
        SELECT ${taskBoardColumns}
        FROM "Task" task
        INNER JOIN "Project" project ON project."id" = task."projectId"
        WHERE task."deletedAt" IS NULL
          AND project."archivedAt" IS NULL
          ${projectFilter}
          ${statusFilter}
          ${parentFilter}
        ORDER BY
          CASE task."status"
            WHEN ${TaskStatus.IN_PROGRESS} THEN 0
            WHEN ${TaskStatus.IN_REVIEW} THEN 1
            WHEN ${TaskStatus.TODO} THEN 2
            WHEN ${TaskStatus.DONE} THEN 3
            WHEN ${TaskStatus.CANCELLED} THEN 4
            ELSE 99
          END ASC,
          CASE WHEN task."status" = ${TaskStatus.IN_REVIEW} THEN task."priority" ELSE 0 END DESC,
          task."position" ASC,
          task."id" ASC
        LIMIT ${limit} OFFSET ${skip}
      `),
      prisma.task.count({ where }),
    ]);

    // A child can rank ahead of its completed parent or fall on another page.
    // Return compact parent context without changing the page's count/limit.
    const pageIds = new Set(tasks.map((task) => task.id));
    const missingParentIds = [...new Set(tasks.flatMap((task) =>
      task.parentTaskId && !pageIds.has(task.parentTaskId) ? [task.parentTaskId] : []
    ))];
    const parents = params.parentTaskId || missingParentIds.length === 0 ? []
      : await prisma.$queryRaw<TaskBoardTaskRow[]>(Prisma.sql`
        SELECT ${taskBoardColumns} FROM "Task" task
        INNER JOIN "Project" project ON project."id" = task."projectId"
        WHERE task."id" IN (${Prisma.join(missingParentIds)})
          AND task."deletedAt" IS NULL AND project."archivedAt" IS NULL
      `);
    const allTasks = [...tasks, ...parents];
    const taskIds = allTasks.map((task) => task.id);
    const workspaceRows = taskIds.length === 0
      ? []
      : await prisma.$queryRaw<TaskBoardWorkspaceRow[]>(Prisma.sql`
          SELECT
            workspace."id" AS "workspaceId",
            workspace."taskId" AS "taskId",
            workspace."status" AS "workspaceStatus",
            workspace."workspaceKind" AS "workspaceKind",
            workspace."branchName" AS "branchName",
            latest."agentType" AS "agentType",
            EXISTS (
              SELECT 1
              FROM "Session" active
              WHERE active."workspaceId" = workspace."id"
                AND active."purpose" = ${SessionPurpose.CHAT}
                AND active."status" IN (${SessionStatus.PENDING}, ${SessionStatus.RUNNING})
            ) AS "hasActiveSession"
          FROM "Workspace" workspace
          LEFT JOIN "Session" latest ON latest."id" = (
            SELECT candidate."id"
            FROM "Session" candidate
            WHERE candidate."workspaceId" = workspace."id"
              AND candidate."purpose" = ${SessionPurpose.CHAT}
            ORDER BY candidate."createdAt" DESC, candidate."id" DESC
            LIMIT 1
          )
          WHERE workspace."taskId" IN (
            SELECT value FROM json_each(${JSON.stringify(taskIds)})
          )
          ORDER BY workspace."createdAt" ASC, workspace."id" ASC
        `);

    const workspaces = workspaceRows.map((row) => ({
      id: row.workspaceId,
      taskId: row.taskId,
      status: row.workspaceStatus,
      workspaceKind: row.workspaceKind,
      branchName: row.branchName,
      agentType: row.agentType,
      hasActiveSession: Boolean(row.hasActiveSession),
    }));

    const workspacesByTaskId = new Map<string, typeof workspaces>();
    for (const workspace of workspaces) {
      const group = workspacesByTaskId.get(workspace.taskId) ?? [];
      group.push(workspace);
      workspacesByTaskId.set(workspace.taskId, group);
    }

    const preferredWorkspaceByTaskId = new Map<string, (typeof workspaces)[number]>();
    for (const task of allTasks) {
      const candidates = workspacesByTaskId.get(task.id) ?? [];
      const preferred = candidates.find((workspace) => workspace.status === WorkspaceStatus.ACTIVE)
        ?? candidates[0];
      if (preferred) {
        preferredWorkspaceByTaskId.set(task.id, preferred);
      }
    }

    const data: TaskBoardItem[] = allTasks.map((task) => {
      const titlePreview = buildTextPreview(task.title, TASK_TITLE_MAX_LENGTH);
      const preferredWorkspace = preferredWorkspaceByTaskId.get(task.id);
      const hasRunningSession = (workspacesByTaskId.get(task.id) ?? [])
        .some((workspace) => workspace.hasActiveSession);
      const updatedAt = task.updatedAt instanceof Date
        ? task.updatedAt.getTime()
        : new Date(task.updatedAt).getTime();

      return {
        id: task.id,
        projectId: task.projectId,
        parentTaskId: task.parentTaskId,
        subtaskCount: Number(task.subtaskCount),
        runningSubtaskCount: Number(task.runningSubtaskCount),
        title: titlePreview,
        status: task.status as TaskStatus,
        priority: task.priority ?? TaskPriority.NORMAL,
        ...(preferredWorkspace ? {
          preferredWorkspace: {
            ...(preferredWorkspace.workspaceKind === WorkspaceKind.MAIN_DIRECTORY
              ? { workspaceKind: WorkspaceKind.MAIN_DIRECTORY }
              : {}),
            branchName: preferredWorkspace.branchName,
          },
        } : {}),
        ...(preferredWorkspace?.agentType ? {
          latestAgentType: preferredWorkspace.agentType as import('@agent-tower/shared').AgentType,
        } : {}),
        ...(hasRunningSession ? { hasRunningSession: true as const } : {}),
        updatedAt,
      };
    });

    return {
      data: data.slice(0, tasks.length),
      ...(parents.length ? { parents: data.slice(tasks.length) } : {}),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * 获取项目的任务列表（支持按状态过滤和分页）
   */
  async findByProjectId(projectId: string, params: FindTasksParams = {}) {
    // 校验项目存在
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    const page = Math.max(1, params.page || 1);
    const limit = Math.min(1000, Math.max(1, params.limit || 200));
    const skip = (page - 1) * limit;

    const where: any = { projectId, deletedAt: null };
    if (params.status) {
      where.status = params.status;
    }

    // Active tasks first (IN_PROGRESS → IN_REVIEW → TODO), then completed (DONE → CANCELLED).
    // Raw SQL CASE needed because Prisma orderBy doesn't support custom sort functions.
    const statusOrder: Record<string, number> = {
      [TaskStatus.IN_PROGRESS]: 0,
      [TaskStatus.IN_REVIEW]: 1,
      [TaskStatus.TODO]: 2,
      [TaskStatus.DONE]: 3,
      [TaskStatus.CANCELLED]: 4,
    };

    const [data, total] = await Promise.all([
      prisma.task.findMany({
        where,
        select: {
          id: true,
          projectId: true,
          title: true,
          baseBranch: true,
          parentTaskId: true,
          status: true,
          priority: true,
          position: true,
          createdAt: true,
          updatedAt: true,
          workspaces: { include: { sessions: visibleSessionSummary } },
          project: true,
        },
        orderBy: [{ updatedAt: 'desc' }],
        skip,
        take: limit,
      }),
      prisma.task.count({ where }),
    ]);

    data.sort((a, b) => {
      const sa = statusOrder[a.status] ?? 99;
      const sb = statusOrder[b.status] ?? 99;
      if (sa !== sb) return sa - sb;
      if (a.status === TaskStatus.IN_REVIEW) {
        const priorityDelta = (b.priority ?? TaskPriority.NORMAL) - (a.priority ?? TaskPriority.NORMAL);
        if (priorityDelta !== 0) return priorityDelta;
      }
      return (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id);
    });

    const projectGitCapability = getStoredProjectGitCapability(project);

    return {
      data: data.map((task) => (
        withTaskPreviews(withProjectGitCapability(task, projectGitCapability), { omitDescription: true })
      )),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * 获取任务详情
   */
  async findById(id: string) {
    const task = await prisma.task.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        projectId: true,
        project: true,
        title: true,
        baseBranch: true,
        parentTaskId: true,
        _count: { select: { subtasks: { where: { deletedAt: null } } } },
        status: true,
        priority: true,
        position: true,
        createdAt: true,
        updatedAt: true,
        workspaces: { include: { sessions: visibleSessionSummary } },
      },
    });

    if (!task) {
      throw new NotFoundError('Task', id);
    }

    const { _count, ...metadata } = task;
    return withTaskPreviews(withProjectGitMetadata({ ...metadata, subtaskCount: _count.subtasks }), { omitDescription: true });
  }

  async findSubtasks(id: string, params: FindTasksParams = {}) {
    const parent = await prisma.task.findFirst({ where: { id, deletedAt: null } });
    if (!parent) throw new NotFoundError('Task', id);
    return this.findBoard({ ...params, projectId: parent.projectId, parentTaskId: id });
  }

  async findBodyById(id: string) {
    const task = await prisma.task.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        title: true,
        description: true,
      },
    });

    if (!task) {
      throw new NotFoundError('Task', id);
    }

    const hasDescription = Boolean(task.description?.trim());
    const titlePreview = buildTextPreview(task.title, TASK_TITLE_MAX_LENGTH);
    const usesHistoricalTitleBody =
      !hasDescription
      && (task.title.length > TASK_HISTORICAL_TITLE_BODY_THRESHOLD || task.title !== titlePreview);
    const body = hasDescription
      ? task.description!
      : usesHistoricalTitleBody
        ? task.title
        : '';
    const prompt = hasDescription
      ? buildTaskPrompt(task)
      : usesHistoricalTitleBody
        ? task.title
        : task.title.trim();

    return {
      taskId: task.id,
      title: titlePreview,
      titlePreview,
      body,
      bodySource: hasDescription ? 'description' : usesHistoricalTitleBody ? 'historical_title' : 'none',
      prompt,
      isTruncated: task.title !== titlePreview,
    };
  }

  /**
   * 创建任务
   * - 校验项目存在
   * - 自动计算 position（同状态下最大 position + 1）
   */
  async create(projectId: string, input: CreateTaskInput) {
    const normalizedInput = normalizeCreateTaskInput(input);

    // 校验项目存在
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }
    ensureProjectIsMutable(project, 'create tasks');

    const parent = input.parentTaskId ? await prisma.task.findFirst({
      where: { id: input.parentTaskId, projectId, deletedAt: null },
      include: { workspaces: {
        where: { parentWorkspaceId: null, ownerMemberId: null, status: { not: WorkspaceStatus.ABANDONED } },
        orderBy: { createdAt: 'desc' },
      } },
    }) : null;
    if (input.parentTaskId && !parent) throw new NotFoundError('Parent task', input.parentTaskId);
    if (parent?.parentTaskId) throw new ValidationError('Subtasks cannot have their own subtasks');
    const parentWorkspace = parent?.workspaces.find((workspace) => workspace.status === WorkspaceStatus.ACTIVE)
      ?? parent?.workspaces.find((workspace) => workspace.status === WorkspaceStatus.HIBERNATED)
      ?? parent?.workspaces[0];
    const parentBranch = parentWorkspace?.branchName || parent?.baseBranch;

    const createWithParentBranch = async () => {
      // Resolve at task creation so delayed starts and TeamRun main workspaces
      // cannot silently follow a later project default change. Local tasks opt out.
      let baseBranch: string | null = null;
      if (input.baseBranch !== null) {
        const requestedBranch = input.baseBranch ?? parentBranch ?? (
          (await detectProjectGitCapability(project.repoPath)).worktreeReady ? project.mainBranch : null
        );
        if (requestedBranch !== null) {
          baseBranch = await requireLocalBaseBranch(project.repoPath, requestedBranch);
        }
      }

      // 自动计算 position
      const maxPosition = await prisma.task.aggregate({
        where: { projectId, status: TaskStatus.TODO, deletedAt: null },
        _max: { position: true },
      });

      const created = await prisma.$transaction(async (tx) => {
        // Recheck after Git validation, serialized with the deletion marker.
        if (parent) {
          const liveParent = await tx.task.findFirst({
            where: { id: parent.id, projectId, deletedAt: null, project: { archivedAt: null } },
          });
          if (!liveParent) throw new NotFoundError('Parent task', parent.id);
        }
        return tx.task.create({
          data: {
            title: normalizedInput.title,
            description: normalizedInput.description,
            priority: normalizedInput.priority ?? TaskPriority.NORMAL,
            baseBranch,
            parentTaskId: parent?.id,
            position: (maxPosition._max.position ?? 0) + 1,
            projectId,
          },
        });
      });
      this.eventBus.emit('task:updated', { taskId: created.id, projectId, status: created.status });
      if (parent) this.eventBus.emit('task:updated', { taskId: parent.id, projectId, status: parent.status });

      return {
        ...created,
        project: {
          ...project,
          ...buildProjectGitMetadata(project),
        },
      };
    };
    // Serialize branch validation and child persistence with parent workspace
    // cleanup, so its reference becomes visible before that branch is reclaimed.
    return parentWorkspace
      ? defaultWorkspaceLifecycleBarrier.withWorkspace(parentWorkspace.id, createWithParentBranch)
      : createWithParentBranch();
  }

  /**
   * 更新任务基本信息
   */
  async update(id: string, input: UpdateTaskInput) {
    const task = await prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: { project: true },
    });
    if (!task) {
      throw new NotFoundError('Task', id);
    }
    ensureProjectIsMutable(task.project, 'update tasks');
    const normalizedInput = normalizeUpdateTaskInput(task, input);

    const updated = await prisma.task.update({
      where: { id },
      data: normalizedInput,
    });

    if (input.priority !== undefined) {
      this.emitTaskUpdated(id, task.projectId, updated.status, updated.priority);
    }

    return {
      ...updated,
      project: {
        ...task.project,
        ...buildProjectGitMetadata(task.project),
      },
    };
  }

  /**
   * 更新任务状态（含状态流转校验）
   * 更新后通过 EventBus 发射 task:updated 事件，通知前端实时更新
   */
  async updateStatus(id: string, status: TaskStatus) {
    const task = await prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: { project: true },
    });
    if (!task) {
      throw new NotFoundError('Task', id);
    }
    ensureProjectIsMutable(task.project, 'change task status');

    const currentStatus = task.status as TaskStatus;

    // 如果状态没有变化，直接返回
    if (currentStatus === status) {
      return withProjectGitMetadata(task);
    }

    // 校验状态流转是否合法
    const allowedTransitions = VALID_TRANSITIONS[currentStatus];
    if (!allowedTransitions || !allowedTransitions.includes(status)) {
      throw new InvalidStateTransitionError(currentStatus, status);
    }

    // 切换状态时自动计算新列的 position
    const maxPosition = await prisma.task.aggregate({
      where: { projectId: task.projectId, status, deletedAt: null },
      _max: { position: true },
    });

    const updated = await prisma.task.update({
      where: { id },
      data: {
        status,
        position: (maxPosition._max.position ?? 0) + 1,
      },
    });

    // 通知前端
    this.emitTaskUpdated(id, task.projectId, status);

    return {
      ...updated,
      project: {
        ...task.project,
        ...buildProjectGitMetadata(task.project),
      },
    };
  }

  /**
   * 更新任务位置（用于拖拽排序）
   * 如果同时传了 status，会进行状态流转并通知前端
   */
  async updatePosition(id: string, position: number, status?: TaskStatus) {
    const task = await prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: { project: true },
    });
    if (!task) {
      throw new NotFoundError('Task', id);
    }
    ensureProjectIsMutable(task.project, 'reorder tasks');

    // 如果同时传了 status，进行状态流转校验
    if (status && status !== task.status) {
      const currentStatus = task.status as TaskStatus;
      const allowedTransitions = VALID_TRANSITIONS[currentStatus];
      if (!allowedTransitions || !allowedTransitions.includes(status)) {
        throw new InvalidStateTransitionError(currentStatus, status);
      }
    }

    const updated = await prisma.task.update({
      where: { id },
      data: { position, ...(status && { status }) },
    });

    // 如果状态发生了变化，通知前端
    if (status && status !== task.status) {
      this.emitTaskUpdated(id, task.projectId, status);
    }

    return {
      ...updated,
      project: {
        ...task.project,
        ...buildProjectGitMetadata(task.project),
      },
    };
  }

  /**
   * 快速删除任务
   *
   * 1. 在同一事务中标记父子 Task 为 deletedAt，并保存清理快照
   * 2. 普通读取立即隐藏已删除的任务
   * 3. 通过 EventBus 通知前端实时删除
   * 4. 后台 worker 再停止 Session、删除 worktree/branch，并最终硬删除 Task
   */
  async delete(id: string, expectedSubtaskCount?: number) {
    const taskForGuard = await prisma.task.findUnique({ where: { id }, include: { project: true } });
    if (!taskForGuard || taskForGuard.deletedAt) throw new NotFoundError('Task', id);
    ensureProjectIsMutable(taskForGuard.project, 'delete tasks');
    if (expectedSubtaskCount !== undefined && expectedSubtaskCount !== await prisma.task.count({
      where: { parentTaskId: id, deletedAt: null },
    })) {
      throw new ServiceError('Subtasks changed. Review the deletion confirmation again.', 'TASK_DELETE_SCOPE_CHANGED', 409);
    }

    const workspaceIds = await prisma.workspace.findMany({
      where: { task: { OR: [{ id }, { parentTaskId: id }], deletedAt: null } },
      select: { id: true },
    });
    const result = await defaultWorkspaceLifecycleBarrier.withWorkspaces(
      workspaceIds.map((workspace) => workspace.id), async () => {
        for (const workspace of workspaceIds) await this.backgroundService?.stopAllForWorkspace(workspace.id);
        // Mark the complete family and persist its recovery snapshot together.
        // Child creation rechecks the parent inside its own transaction.
        return prisma.$transaction(async (tx) => {
          const parent = await tx.task.findFirst({ where: { id, deletedAt: null }, include: { project: true } });
          if (!parent) throw new NotFoundError('Task', id);
          ensureProjectIsMutable(parent.project, 'delete tasks');
          const family = await tx.task.findMany({
            where: { OR: [{ id }, { parentTaskId: id }], deletedAt: null },
            select: { id: true },
          });
          if (expectedSubtaskCount !== undefined && expectedSubtaskCount !== family.length - 1) {
            throw new ServiceError('Subtasks changed. Review the deletion confirmation again.', 'TASK_DELETE_SCOPE_CHANGED', 409);
          }
          const taskIds = [...family.filter((task) => task.id !== id).map((task) => task.id), id];
          await tx.task.updateMany({ where: { id: { in: taskIds } }, data: { deletedAt: new Date() } });
          const tasks = await tx.task.findMany({
            where: { id: { in: taskIds } },
            include: {
              workspaces: { include: { sessions: true } },
              teamRun: { include: { invocations: {
                where: { status: { in: CANCELLABLE_DELETE_INVOCATION_STATUSES } }, select: { id: true },
              } } },
            },
          });
          const tasksById = new Map(tasks.map((task) => [task.id, task]));
          const orderedTasks = taskIds.map((taskId) => tasksById.get(taskId)!);
          const snapshot: TaskCleanupSnapshot = {
            taskId: id, taskIds, projectId: parent.projectId,
            project: { repoPath: parent.project.repoPath, mainBranch: parent.project.mainBranch },
            workspaces: orderedTasks.flatMap((task) => task.workspaces.map((workspace) => ({
              id: workspace.id,
              worktreePath: workspace.worktreePath,
              workingDir: getWorkspaceWorkingDir(workspace),
              workspaceKind: workspace.workspaceKind,
              branchName: workspace.branchName,
              baseBranch: workspace.baseBranch,
              sessions: workspace.sessions.map((session) => ({ id: session.id })),
            }))),
          };
          await tx.taskCleanupJob.create({
            data: { taskId: id, projectId: parent.projectId, payload: JSON.stringify(snapshot) },
          });
          const teamRunIds = tasks.flatMap((task) => task.teamRun ? [task.teamRun.id] : []);
          if (teamRunIds.length) {
            await tx.workRequest.updateMany({
              where: { teamRunId: { in: teamRunIds }, status: { in: CANCELLABLE_DELETE_WORK_REQUEST_STATUSES } },
              data: { status: 'CANCELLED' },
            });
            await tx.agentInvocation.updateMany({
              where: { teamRunId: { in: teamRunIds }, status: { in: CANCELLABLE_DELETE_INVOCATION_STATUSES } },
              data: { status: 'CANCELLED', nextRoomReplyReminderAt: null },
            });
          }
          return {
            taskIds, projectId: parent.projectId,
            invocationIds: tasks.flatMap((task) => task.teamRun?.invocations.map((invocation) => invocation.id) ?? []),
          };
        });
      },
    );
    for (const invocationId of result.invocationIds) defaultTeamLockService.releaseByOwner(invocationId);
    for (const taskId of result.taskIds) this.eventBus.emit('task:deleted', { taskId, projectId: result.projectId });
    this.cleanupService?.trigger();
    return true;
  }

  async getCleanupStatus(taskId: string) {
    const job = await prisma.taskCleanupJob.findFirst({
      where: { taskId }, orderBy: { createdAt: 'desc' },
      select: { taskId: true, status: true, lastError: true, nextRetryAt: true },
    });
    if (!job) throw new NotFoundError('Task cleanup', taskId);
    return job;
  }

  async retryCleanup(taskId: string) {
    const job = await prisma.taskCleanupJob.findFirst({ where: { taskId }, orderBy: { createdAt: 'desc' } });
    if (!job) throw new NotFoundError('Task cleanup', taskId);
    const project = await prisma.project.findUnique({ where: { id: job.projectId } });
    if (!project) throw new NotFoundError('Project', job.projectId);
    ensureProjectIsMutable(project, 'retry task cleanup');
    await prisma.taskCleanupJob.updateMany({
      where: { id: job.id, status: 'FAILED' },
      data: { status: 'PENDING', attempts: 0, lastError: null, nextRetryAt: null },
    });
    this.cleanupService?.trigger();
    return this.getCleanupStatus(taskId);
  }

  /**
   * 获取项目的任务统计
   */
  async getStatsByProjectId(projectId: string) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    const counts = await prisma.task.groupBy({
      by: ['status'],
      where: { projectId, deletedAt: null },
      _count: { id: true },
    });

    const stats = {
      total: 0,
      todo: 0,
      inProgress: 0,
      inReview: 0,
      done: 0,
      cancelled: 0,
    };

    for (const row of counts) {
      const count = row._count.id;
      stats.total += count;
      switch (row.status) {
        case TaskStatus.TODO:
          stats.todo = count;
          break;
        case TaskStatus.IN_PROGRESS:
          stats.inProgress = count;
          break;
        case TaskStatus.IN_REVIEW:
          stats.inReview = count;
          break;
        case TaskStatus.DONE:
          stats.done = count;
          break;
        case TaskStatus.CANCELLED:
          stats.cancelled = count;
          break;
      }
    }

    return stats;
  }

  /**
   * 重试任务
   *
   * 1. 停止当前 ACTIVE Workspace 的所有 Session
   * 2. 将 ACTIVE Workspace 标记为 ABANDONED（保留 worktree 供参考）
   * 3. 重置 Task 状态为 TODO
   * 4. 通知前端 — 用户可重新派发 Agent（会创建新 Worktree）
   */
  async retry(id: string, options: { preserveWorkspaceId?: string; preserveSessionId?: string } = {}) {
    const task = await prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: {
        project: true,
        workspaces: {
          where: { status: WorkspaceStatus.ACTIVE },
          include: { sessions: true },
        },
      },
    });
    if (!task) {
      throw new NotFoundError('Task', id);
    }
    ensureProjectIsMutable(task.project, 'retry tasks');

    // 停止活跃 Session 并归档 Workspace
    for (const workspace of task.workspaces) {
      const activeSessions = workspace.sessions.filter(
        (s) => s.id !== options.preserveSessionId && (s.status === SessionStatus.PENDING || s.status === SessionStatus.RUNNING)
      );
      for (const session of activeSessions) {
        try {
          await this.sessionManager.stop(session.id);
        } catch (err) {
          console.warn(`[TaskService] retry: failed to stop session ${session.id}:`, err);
        }
      }
      if (workspace.id !== options.preserveWorkspaceId) await prisma.workspace.update({
        where: { id: workspace.id },
        data: { status: WorkspaceStatus.ABANDONED },
      });
    }

    // 重置 Task 到 TODO
    const updated = await prisma.task.update({
      where: { id },
      data: { status: TaskStatus.TODO },
    });

    this.emitTaskUpdated(id, task.projectId, TaskStatus.TODO);

    return {
      ...updated,
      project: {
        ...task.project,
        ...buildProjectGitMetadata(task.project),
      },
    };
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────────

  /**
   * 发射 task:updated 事件，通知 SocketGateway 转发到前端
   */
  emitTaskUpdated(taskId: string, projectId: string, status: string, priority?: number): void {
    this.eventBus.emit('task:updated', {
      taskId,
      projectId,
      status,
      ...(priority === undefined ? {} : { priority }),
    });
  }
}
