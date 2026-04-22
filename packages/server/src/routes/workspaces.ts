import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { WorkspaceService } from '../services/workspace.service.js';
import { ServiceError, NotFoundError } from '../errors.js';
import { GitError, MergeConflictError, RebaseInProgressError } from '../git/worktree.manager.js';
import { parseSessionTokenUsage } from './sessions.js';

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
});

/**
 * 统一错误响应格式
 */
function errorResponse(error: string, code: string) {
  return { error, code };
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
        body.branchName
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

  // ── 合并工作空间到主分支 ────────────────────────────────────────────────────

  const mergeSchema = z.object({
    commitMessage: z.string().min(1).optional(),
  });

  app.post<{ Params: { id: string } }>(
    '/workspaces/:id/merge',
    async (request) => {
      const body = mergeSchema.parse(request.body || {});
      const sha = await workspaceService.merge(request.params.id, body.commitMessage);
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

      if (!workspace.worktreePath) {
        reply.code(400);
        return errorResponse('Workspace has no worktree path', 'NO_WORKTREE_PATH');
      }

      const command = resolveEditorCommand(body.editorType);
      spawn(command, [workspace.worktreePath], {
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
