import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { AgentType } from '../types/index.js';
import { stripAnsiSequences } from '../output/utils/ansi.js';
import { discoverSkillCatalog, discoverSlashCommandCatalog } from '../services/slash-command-catalog.service.js';
import { prisma } from '../utils/index.js';

const execFileAsync = promisify(execFile);

/** 解析 `cursor-agent --list-models`  stdout（strip ANSI 后按行解析） */
export function parseCursorAgentListModelsOutput(stdout: string): Array<{ id: string; label: string }> {
  const text = stripAnsiSequences(stdout);
  const lines = text.split(/\r?\n/);
  const models: Array<{ id: string; label: string }> = [];
  let inList = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t === 'Available models') {
      inList = true;
      continue;
    }
    if (t.startsWith('Tip:')) break;
    if (!inList) continue;
    const m = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*-\s*(.+)$/.exec(t);
    if (m) {
      const label = m[2]
        .trim()
        .replace(/\s*\(current\)\s*$/i, '')
        .replace(/\s*\(default\)\s*$/i, '')
        .trim();
      models.push({ id: m[1], label });
    }
  }
  return models;
}

export async function systemRoutes(app: FastifyInstance) {
  // 健康检查
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // 获取可用的 AI 代理列表
  app.get('/agents', async () => {
    return {
      agents: [
        { type: AgentType.CLAUDE_CODE, name: 'Claude Code', available: false },
        { type: AgentType.GEMINI_CLI, name: 'Gemini CLI', available: false },
      ],
    };
  });

  /** Cursor Agent CLI 可用模型（与 `cursor-agent --list-models` 一致，供 Provider 配置 UI 使用） */
  app.get('/system/cursor-agent-models', async () => {
    try {
      const { stdout } = await execFileAsync('cursor-agent', ['--list-models'], {
        timeout: 25_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf-8',
        ...(process.platform === 'win32' ? { shell: true } : {}),
      });
      const models = parseCursorAgentListModelsOutput(stdout);
      return { models };
    } catch (e) {
      return {
        models: [] as Array<{ id: string; label: string }>,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });

  app.get('/system/slash-command-catalog', async (request) => {
    const { agentType, workingDir } = request.query as { agentType?: string; workingDir?: string };
    return discoverSlashCommandCatalog(agentType, workingDir);
  });

  app.get('/system/skill-catalog', async (request) => {
    const { agentType, workingDir } = request.query as { agentType?: string; workingDir?: string };
    return discoverSkillCatalog(agentType, workingDir);
  });

  // MCP 上下文检测：根据 cwd 路径查找匹配的活跃工作空间
  app.get('/system/workspace-context', async (request, reply) => {
    const { path: cwdPath } = request.query as { path?: string };
    if (!cwdPath) {
      reply.code(400);
      return { error: 'path query parameter is required' };
    }

    const workspace = await prisma.workspace.findFirst({
      where: { worktreePath: cwdPath, status: 'ACTIVE' },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      reply.code(404);
      return { error: 'No active workspace found for this path' };
    }

    return {
      projectId: workspace.task.project.id,
      projectName: workspace.task.project.name,
      taskId: workspace.task.id,
      taskTitle: workspace.task.title,
      workspaceId: workspace.id,
      workspaceBranch: workspace.branchName,
    };
  });
}
