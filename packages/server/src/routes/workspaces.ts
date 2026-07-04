import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { WorkspaceService } from '../services/workspace.service.js';
import { ServiceError, NotFoundError } from '../errors.js';
import { GitError, MergeConflictError, RebaseInProgressError } from '../git/worktree.manager.js';
import { parseSessionTokenUsage } from './sessions.js';
import { WorkspaceKind } from '../types/index.js';
import { getWorkspaceWorkingDir } from '../services/workspace-kind.js';

/**
 * Parse tokenUsage on all sessions nested inside workspace(s).
 */
function parseWorkspaceSessions<T extends { sessions?: Array<{ tokenUsage?: string | null }> }>(ws: T): T {
  if (ws.sessions) {
    ws.sessions.forEach(parseSessionTokenUsage);
  }
  return ws;
}

// ── IDE 命令映射 ─────────────────────────────────────────────────────────────

const IDE_COMMANDS: Record<string, string> = {
  cursor: 'cursor',
  vscode: 'code',
  'vscode-insiders': 'code-insiders',
  windsurf: 'windsurf',
  zed: 'zed',
};

const openEditorSchema = z.object({
  editorType: z.enum(['cursor', 'vscode', 'vscode-insiders', 'windsurf', 'zed']).nullable().optional(),
});

/**
 * 解析 IDE 命令：如果指定了 editorType 则使用对应命令，否则默认 cursor → code fallback
 */
function resolveEditorCommand(editorType?: string | null): string {
  if (editorType && IDE_COMMANDS[editorType]) {
    return IDE_COMMANDS[editorType];
  }
  // 默认使用 cursor，fallback 到 code
  return 'cursor';
}

const createWorkspaceSchema = z.object({
  branchName: z.string().min(1).optional(),
  workspaceKind: z.nativeEnum(WorkspaceKind).optional(),
});

const workspaceVerdictSchema = z.object({
  kind: z.enum(['REVIEW', 'TEST']),
  verdict: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'PASSED', 'FAILED']),
  reviewedSha: z.string().min(1),
  reason: z.string().optional().nullable(),
});

/**
 * 统一错误响应格式
 */
function errorResponse(error: string, code: string) {
  return { error, code };
}

function getInvocationId(request: { headers: Record<string, unknown> }): string | null {
  const header = request.headers['x-agent-tower-invocation-id'];
  return typeof header === 'string' && header.length > 0 ? header : null;
}

export async function workspaceRoutes(app: FastifyInstance) {
  const workspaceService = new WorkspaceService();

  // ── 错误处理钩子 ────────────────────────────────────────────────────────────

  app.setErrorHandler((error, _request, reply) => {
    // ServiceError（业务错误）
    if (error instanceof ServiceError) {
      reply.code(error.statusCode);
      return errorResponse(error.message, error.code);
    }

    // MergeConflictError → 409 with conflict details
    if (error instanceof MergeConflictError) {
      reply.code(409);
      return {
        error: error.message,
        code: error.code,
        conflictedFiles: error.conflictedFiles,
        conflictOp: error.conflictOp,
        mergeAborted: error.mergeAborted,
        mergeStrategy: error.mergeStrategy,
        sourceBranch: error.sourceBranch,
        targetBranch: error.targetBranch,
        sourceWorktreePath: error.sourceWorktreePath,
        targetWorktreePath: error.targetWorktreePath,
        sourceWorkspaceId: error.sourceWorkspaceId,
        targetWorkspaceId: error.targetWorkspaceId,
      };
    }

    // RebaseInProgressError → 409
    if (error instanceof RebaseInProgressError) {
      reply.code(409);
      return errorResponse(error.message, error.code);
    }

    // GitError（Git 操作错误）
    if (error instanceof GitError) {
      reply.code(400);
      return errorResponse(error.message, error.code);
    }

    // Zod 校验错误
    if (error.name === 'ZodError') {
      reply.code(400);
      return errorResponse(error.message, 'VALIDATION_ERROR');
    }

    // 未知错误
    app.log.error(error);
    reply.code(500);
    return errorResponse('Internal server error', 'INTERNAL_ERROR');
  });

  // ── 创建工作空间 ────────────────────────────────────────────────────────────

  app.post<{ Params: { taskId: string } }>(
    '/tasks/:taskId/workspaces',
    async (request, reply) => {
      const body = createWorkspaceSchema.parse(request.body || {});
      const workspace = await workspaceService.create(
        request.params.taskId,
        {
          branchName: body.branchName,
          workspaceKind: body.workspaceKind,
        }
      );
      reply.code(201);
      return parseWorkspaceSessions(workspace);
    }
  );

  // ── 获取 Task 下所有 Workspace ──────────────────────────────────────────────

  app.get<{ Params: { taskId: string } }>(
    '/tasks/:taskId/workspaces',
    async (request) => {
      const workspaces = await workspaceService.findByTaskId(request.params.taskId);
      return workspaces.map(parseWorkspaceSessions);
    }
  );

  // ── 获取工作空间详情 ────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/workspaces/:id',
    async (request, reply) => {
      const workspace = await workspaceService.findById(request.params.id);
      if (!workspace) {
        reply.code(404);
        return errorResponse('Workspace not found', 'NOT_FOUND');
      }
      return parseWorkspaceSessions(workspace);
    }
  );

  // ── 获取工作空间的 diff ──────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/workspaces/:id/diff',
    async (request) => {
      const diff = await workspaceService.getDiff(request.params.id);
      return { diff };
    }
  );

  app.get<{ Params: { id: string } }>(
    '/workspaces/:id/verdicts',
    async (request) => {
      return workspaceService.listVerdicts(request.params.id);
    }
  );

  app.post<{ Params: { id: string } }>(
    '/workspaces/:id/verdicts',
    async (request, reply) => {
      const body = workspaceVerdictSchema.parse(request.body || {});
      const invocationId = getInvocationId(request);
      const identity = await workspaceService.resolveInvocationMemberForWorkspace(request.params.id, invocationId);
      if (!identity) {
        throw new ServiceError(
          'A valid TeamRun agent invocation identity is required to record workspace verdicts',
          'TEAM_RUN_INVOCATION_REQUIRED',
          403
        );
      }
      if (identity.targetSourceWorkspaceId === request.params.id) {
        if (!identity.targetHeadSha) {
          throw new ServiceError(
            'Targeted invocation is missing targetHeadSha for workspace verdict',
            'TARGET_VERDICT_TARGET_MISSING',
            409
          );
        }
      }
      const verdict = await workspaceService.recordVerdict(request.params.id, {
        kind: body.kind,
        verdict: body.verdict,
        reviewedSha: body.reviewedSha,
        reviewerMemberId: identity.memberId,
        expectedTargetHeadSha: identity.targetSourceWorkspaceId === request.params.id
          ? identity.targetHeadSha
          : null,
        reason: body.reason,
      });
      reply.code(201);
      return verdict;
    }
  );

  // ── 合并工作空间到主分支 ────────────────────────────────────────────────────

  const mergeSchema = z.object({
    commitMessage: z.string().min(1).optional(),
  });

  app.post<{ Params: { id: string } }>(
    '/workspaces/:id/merge',
    async (request) => {
      const body = mergeSchema.parse(request.body || {});
      const invocationId = getInvocationId(request) ?? undefined;
      const identity = await workspaceService.resolveInvocationMemberForWorkspace(request.params.id, invocationId);
      const sha = await workspaceService.merge(request.params.id, {
        commitMessage: body.commitMessage,
        lockOwnerId: invocationId,
        invocationId,
        requesterMemberId: identity?.memberId,
      });
      return { success: true, sha };
    }
  );

  // ── 归档工作空间 ────────────────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    '/workspaces/:id/archive',
    async (request) => {
      const workspace = await workspaceService.archive(request.params.id);
      return workspace;
    }
  );

  // ── 删除工作空间 ────────────────────────────────────────────────────────────

  app.delete<{ Params: { id: string } }>(
    '/workspaces/:id',
    async (request, reply) => {
      await workspaceService.delete(request.params.id);
      reply.code(204);
      return;
    }
  );

  // ── 在 IDE 中打开工作空间 ──────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    '/workspaces/:id/open-editor',
    async (request, reply) => {
      const { id } = request.params;
      const body = openEditorSchema.parse(request.body || {});

      const workspace = await workspaceService.findById(id);
      if (!workspace) {
        reply.code(404);
        return errorResponse('Workspace not found', 'NOT_FOUND');
      }

      const workingDir = getWorkspaceWorkingDir(workspace);
      if (!workingDir) {
        reply.code(400);
        return errorResponse('Workspace has no working directory', 'NO_WORKING_DIR');
      }

      const command = resolveEditorCommand(body.editorType);
      spawn(command, [workingDir], {
        detached: true,
        shell: process.platform === 'win32',
        stdio: 'ignore',
      }).unref();

      return { success: true };
    }
  );

  // ── Rebase 工作空间 ──────────────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    '/workspaces/:id/rebase',
    async (request) => {
      await workspaceService.rebase(request.params.id);
      return { success: true };
    }
  );

  // ── 获取工作空间 Git 操作状态 ──────────────────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/workspaces/:id/git-status',
    async (request) => {
      return workspaceService.getGitStatus(request.params.id);
    }
  );

  // ── 中止当前 Git 操作 ──────────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    '/workspaces/:id/abort-operation',
    async (request) => {
      await workspaceService.abortOperation(request.params.id);
      return { success: true };
    }
  );

  // ── 唤醒休眠工作空间 ────────────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    '/workspaces/:id/reactivate',
    async (request) => {
      const workspace = await workspaceService.reactivate(request.params.id);
      return parseWorkspaceSessions(workspace);
    }
  );

  // ── 系统清理 ────────────────────────────────────────────────────────────────

  app.post('/system/cleanup', async () => {
    const cleaned = await workspaceService.cleanup();
    return { success: true, cleaned };
  });

  // ── 手动触发空闲休眠 ──────────────────────────────────────────────────────

  const hibernateIdleSchema = z.object({
    idleThresholdHours: z.number().min(1).optional(),
  });

  app.post('/system/hibernate-idle', async (request) => {
    const body = hibernateIdleSchema.parse(request.body || {});
    const hibernated = await workspaceService.hibernateIdle(body.idleThresholdHours);
    return { success: true, hibernated };
  });
}
