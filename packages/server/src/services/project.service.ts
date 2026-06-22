import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../utils/index.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { execGit } from '../git/git-cli.js';
import { getWorkspaceGitWatcherService } from '../core/container.js';
import { ensureProjectIsMutable, hasGitMetadata } from './project-guards.js';
import type { WorkspaceGitWatcherService } from './workspace-git-watcher.service.js';
import {
  TaskStatus,
  SessionStatus,
  WorkspaceStatus,
  WorkspaceKind,
} from '../types/index.js';

interface CreateProjectInput {
  name: string;
  description?: string;
  repoPath: string;
  mainBranch?: string;
  initEmptyRepo?: boolean;
  copyFiles?: string;
  setupScript?: string;
  quickCommands?: string;
}

interface UpdateProjectInput {
  name?: string;
  description?: string;
  mainBranch?: string;
  copyFiles?: string | null;
  setupScript?: string | null;
  quickCommands?: string | null;
}

interface PaginationParams {
  page?: number;
  limit?: number;
  includeArchived?: boolean;
}

interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** 各状态的任务数量统计 */
interface TaskStats {
  total: number;
  todo: number;
  inProgress: number;
  inReview: number;
  done: number;
}

interface ArchiveProjectInput {
  deleteRepo?: boolean;
}

interface RestoreProjectInput {
  repoPath?: string;
}

interface RestoreProjectResult<T> {
  project: T;
  warnings: string[];
}

async function getRepoRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const remote = await execGit(repoPath, ['remote', 'get-url', 'origin']);
    const value = remote.trim();
    return value || null;
  } catch {
    return null;
  }
}

function assertDirectoryPathExists(resolvedPath: string): void {
  if (!fs.existsSync(resolvedPath)) {
    throw new ValidationError(
      `Project path does not exist: ${resolvedPath}`
    );
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isDirectory()) {
    throw new ValidationError(
      `Project path is not a directory: ${resolvedPath}`
    );
  }
}

async function assertDirectoryIsEmpty(resolvedPath: string): Promise<void> {
  const entries = await fsPromises.readdir(resolvedPath);
  if (entries.length > 0) {
    throw new ValidationError(
      `Project path is not a Git repository and is not empty: ${resolvedPath}`
    );
  }
}

/**
 * 若仓库无任何提交，自动执行一次空提交作为初始基准。
 * git worktree 依赖 HEAD 指向有效 commit，空仓库无法创建 worktree。
 */
async function ensureRepoHasCommit(repoPath: string): Promise<void> {
  try {
    await execGit(repoPath, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    try {
      await execGit(repoPath, [
        '-c',
        'user.name=Agent Tower',
        '-c',
        'user.email=agent-tower@local',
        'commit',
        '--allow-empty',
        '--no-gpg-sign',
        '-m',
        'chore: initial commit',
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `Failed to create initial commit in empty repository: ${msg}`
      );
    }
  }
}

async function initializeEmptyRepository(repoPath: string): Promise<void> {
  await execGit(repoPath, ['init']);
  await execGit(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
}

async function removeGitMetadata(repoPath: string): Promise<void> {
  await fsPromises.rm(path.join(repoPath, '.git'), { recursive: true, force: true }).catch(() => {});
}

async function resolveProjectPath(repoPath: string): Promise<{
  resolvedPath: string;
  repoRemoteUrl: string | null;
}> {
  const resolvedPath = path.resolve(repoPath);
  assertDirectoryPathExists(resolvedPath);

  return {
    resolvedPath,
    repoRemoteUrl: await getRepoRemoteUrl(resolvedPath),
  };
}

async function prepareRepoForProjectCreate(
  repoPath: string,
  initEmptyRepo: boolean
): Promise<{
  resolvedPath: string;
  repoRemoteUrl: string | null;
  initialized: boolean;
}> {
  const resolvedPath = path.resolve(repoPath);
  assertDirectoryPathExists(resolvedPath);

  let initialized = false;
  if (!hasGitMetadata(resolvedPath)) {
    if (!initEmptyRepo) {
      return {
        resolvedPath,
        repoRemoteUrl: null,
        initialized,
      };
    }

    await assertDirectoryIsEmpty(resolvedPath);
    try {
      await initializeEmptyRepository(resolvedPath);
      initialized = true;
    } catch (error) {
      await removeGitMetadata(resolvedPath);
      throw error;
    }
  }

  try {
    await ensureRepoHasCommit(resolvedPath);
  } catch (error) {
    if (initialized) {
      await removeGitMetadata(resolvedPath);
    }
    throw error;
  }

  return {
    resolvedPath,
    repoRemoteUrl: await getRepoRemoteUrl(resolvedPath),
    initialized,
  };
}

async function isValidProjectDirectory(repoPath: string): Promise<boolean> {
  try {
    assertDirectoryPathExists(path.resolve(repoPath));
    return true;
  } catch {
    return false;
  }
}

function buildRepoIdentityWarnings(
  previousProject: { repoPath: string; repoRemoteUrl: string | null },
  nextRepo: { resolvedPath: string; repoRemoteUrl: string | null }
): string[] {
  const warnings: string[] = [];

  const previousBaseName = path.basename(previousProject.repoPath);
  const nextBaseName = path.basename(nextRepo.resolvedPath);
  if (previousBaseName && nextBaseName && previousBaseName !== nextBaseName) {
    warnings.push(
      `Project folder name changed from "${previousBaseName}" to "${nextBaseName}".`
    );
  }

  if (previousProject.repoRemoteUrl && nextRepo.repoRemoteUrl) {
    if (previousProject.repoRemoteUrl !== nextRepo.repoRemoteUrl) {
      warnings.push(
        'The restored repository uses a different origin remote URL than the archived project.'
      );
    }
  } else if (previousProject.repoRemoteUrl && !nextRepo.repoRemoteUrl) {
    warnings.push(
      'The restored repository does not expose an origin remote URL, so Agent Tower could not verify it against the archived project.'
    );
  }

  return warnings;
}

export class ProjectService {
  constructor(
    private readonly workspaceGitWatcher: Pick<WorkspaceGitWatcherService, 'unwatchWorkspace'> = getWorkspaceGitWatcherService(),
  ) {}

  /**
   * 获取项目列表（支持分页）
   */
  async findAll(params: PaginationParams = {}): Promise<PaginatedResult<any>> {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(1000, Math.max(1, params.limit || 20));
    const skip = (page - 1) * limit;
    const where = params.includeArchived ? undefined : { archivedAt: null };

    const [data, total] = await Promise.all([
      prisma.project.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.project.count({ where }),
    ]);

    return {
      data: data.map((project) => this.withGitMetadata(project)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * 根据 ID 查询项目详情，包含任务统计
   */
  async findById(id: string) {
    const project = await prisma.project.findUnique({
      where: { id },
      include: { tasks: { where: { deletedAt: null } } },
    });

    if (!project) {
      throw new NotFoundError('Project', id);
    }

    // 计算各状态的任务数量
    const taskStats: TaskStats = {
      total: project.tasks.length,
      todo: 0,
      inProgress: 0,
      inReview: 0,
      done: 0,
    };

    for (const task of project.tasks) {
      switch (task.status) {
        case TaskStatus.TODO:
          taskStats.todo++;
          break;
        case TaskStatus.IN_PROGRESS:
          taskStats.inProgress++;
          break;
        case TaskStatus.IN_REVIEW:
          taskStats.inReview++;
          break;
        case TaskStatus.DONE:
          taskStats.done++;
          break;
      }
    }

    return { ...this.withGitMetadata(project), taskStats };
  }

  /**
   * 创建项目
   * - 校验项目路径是否存在且为目录
   * - 允许非 Git 目录作为本地项目打开
   * - 允许对空目录执行 Git 初始化
   */
  async create(input: CreateProjectInput) {
    // 检查同名项目
    const existing = await prisma.project.findFirst({
      where: { name: input.name },
    });
    if (existing) {
      throw new ValidationError(
        `A project with name "${input.name}" already exists`
      );
    }

    const { resolvedPath, repoRemoteUrl, initialized } = await prepareRepoForProjectCreate(
      input.repoPath,
      input.initEmptyRepo ?? false
    );

    try {
      const created = await prisma.project.create({
        data: {
          name: input.name,
          description: input.description,
          repoPath: resolvedPath,
          repoRemoteUrl,
          mainBranch: input.mainBranch || 'main',
          copyFiles: input.copyFiles,
          setupScript: input.setupScript,
          quickCommands: input.quickCommands,
        },
      });
      return this.withGitMetadata(created);
    } catch (error) {
      if (initialized) {
        await removeGitMetadata(resolvedPath);
      }
      throw error;
    }
  }

  /**
   * 更新项目
   */
  async update(id: string, input: UpdateProjectInput) {
    // 先确认项目存在
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) {
      throw new NotFoundError('Project', id);
    }
    ensureProjectIsMutable(project, 'update this project');

    // 若更新名称，检查同名
    if (input.name && input.name !== project.name) {
      const existing = await prisma.project.findFirst({
        where: { name: input.name },
      });
      if (existing) {
        throw new ValidationError(
          `A project with name "${input.name}" already exists`
        );
      }
    }

    return prisma.project.update({
      where: { id },
      data: input,
    });
  }

  /**
   * 归档项目（软删除）
   */
  async archive(id: string, input: ArchiveProjectInput = {}) {
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        tasks: {
          include: {
            workspaces: {
              include: { sessions: true },
            },
          },
        },
      },
    });
    if (!project) {
      throw new NotFoundError('Project', id);
    }

    if (project.archivedAt) {
      throw new ValidationError(`Project "${project.name}" is already archived`);
    }

    const allWorkspaces = project.tasks.flatMap((task) => task.workspaces);
    const activeSessions = allWorkspaces.flatMap((workspace) =>
      workspace.sessions.filter(
        (session) =>
          session.status === SessionStatus.PENDING ||
          session.status === SessionStatus.RUNNING
      )
    );

    if (activeSessions.length > 0) {
      throw new ValidationError(
        `Project "${project.name}" still has running sessions. Stop them before deleting the project.`
      );
    }

    const activeWorkspaceIds = allWorkspaces
      .filter((workspace) => workspace.status === WorkspaceStatus.ACTIVE)
      .map((workspace) => workspace.id);

    if (activeWorkspaceIds.length > 0) {
      this.unwatchWorkspaces(activeWorkspaceIds);
      await prisma.workspace.updateMany({
        where: { id: { in: activeWorkspaceIds } },
        data: { status: WorkspaceStatus.ABANDONED },
      });
    }

    if (input.deleteRepo) {
      const uniqueWorktreePaths = Array.from(
        new Set(
          allWorkspaces
            .filter((workspace) => workspace.workspaceKind === WorkspaceKind.WORKTREE)
            .map((workspace) => workspace.worktreePath)
            .filter((value): value is string => Boolean(value))
        )
      );

      await Promise.all(
        uniqueWorktreePaths.map((worktreePath) =>
          fsPromises.rm(worktreePath, { recursive: true, force: true })
        )
      );
      await fsPromises.rm(project.repoPath, { recursive: true, force: true });

      if (allWorkspaces.length > 0) {
        await prisma.workspace.updateMany({
          where: { id: { in: allWorkspaces.map((workspace) => workspace.id) } },
          data: { worktreePath: '', workingDir: '' },
        });
      }
    }

    return prisma.project.update({
      where: { id },
      data: {
        archivedAt: new Date(),
        repoDeletedAt: input.deleteRepo ? new Date() : null,
      },
    });
  }

  async restore(id: string, input: RestoreProjectInput = {}): Promise<RestoreProjectResult<any>> {
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) {
      throw new NotFoundError('Project', id);
    }

    if (!project.archivedAt) {
      throw new ValidationError(`Project "${project.name}" is not archived`);
    }

    const wantsNewRepoPath = Boolean(input.repoPath?.trim());
    const currentPathIsValid = await isValidProjectDirectory(project.repoPath);
    const requiresRepoPath = Boolean(project.repoDeletedAt) || !currentPathIsValid;

    if (requiresRepoPath && !wantsNewRepoPath) {
      throw new ValidationError(
        `Project "${project.name}" needs a valid project path before it can be restored.`
      );
    }

    const nextRepo = wantsNewRepoPath
      ? await resolveProjectPath(input.repoPath!.trim())
      : {
          resolvedPath: project.repoPath,
          repoRemoteUrl: project.repoRemoteUrl,
        };

    const warnings = buildRepoIdentityWarnings(project, nextRepo);

    const restored = await prisma.project.update({
      where: { id },
      data: {
        repoPath: nextRepo.resolvedPath,
        repoRemoteUrl: nextRepo.repoRemoteUrl,
        archivedAt: null,
        repoDeletedAt: null,
      },
    });

    return {
      project: this.withGitMetadata(restored),
      warnings,
    };
  }

  /**
   * 兼容旧的 DELETE 语义：改为归档项目，不再做硬删除。
   */
  async delete(id: string) {
    await this.archive(id, { deleteRepo: false });
    return true;
  }

  private unwatchWorkspaces(workspaceIds: string[]): void {
    for (const workspaceId of workspaceIds) {
      this.workspaceGitWatcher.unwatchWorkspace(workspaceId);
    }
  }

  private withGitMetadata<T extends { repoPath: string }>(project: T): T & { isGitRepo: boolean } {
    return {
      ...project,
      isGitRepo: hasGitMetadata(project.repoPath),
    };
  }
}
