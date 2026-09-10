import type { FastifyInstance } from 'fastify';
import { AgentType } from '../types/index.js';
import { stripAnsiSequences } from '../output/utils/ansi.js';
import { discoverSkillCatalog, discoverSlashCommandCatalog } from '../services/slash-command-catalog.service.js';
import { buildMcpConfigResponse } from '../services/mcp-config.service.js';
import { prisma } from '../utils/index.js';
import { runAgentCliCommand } from '../services/agent-cli/command-runner.js';

const CURSOR_AGENT_MODEL_COMMANDS = ['agent', 'cursor-agent'] as const;

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
        { type: AgentType.CURSOR_AGENT, name: 'Cursor Agent', available: false },
        { type: AgentType.CODEX, name: 'Codex', available: false },
        { type: AgentType.QWEN_CODE, name: 'Qwen Code', available: false },
        { type: AgentType.KIRO_CLI, name: 'Kiro CLI', available: false },
        { type: AgentType.OPENCODE, name: 'OpenCode', available: false },
        { type: AgentType.PI_CODING_AGENT, name: 'Pi Coding Agent', available: false },
        { type: AgentType.GROK_BUILD, name: 'Grok Build', available: false },
        { type: AgentType.DEEPSEEK_HERMES, name: 'DeepSeek Harness', available: false },
      ],
    };
  });

  /** Cursor Agent CLI 可用模型（与 `cursor-agent --list-models` 一致，供 Provider 配置 UI 使用） */
  app.get('/system/cursor-agent-models', async () => {
    let lastError: unknown = null;
    for (const command of CURSOR_AGENT_MODEL_COMMANDS) {
      try {
        const { stdout } = await runAgentCliCommand(
          { command, args: ['--list-models'], timeoutMs: 25_000 },
          {
            platform: process.platform === 'win32' ? 'win32' : null,
            env: process.env,
          }
        );
        const models = parseCursorAgentListModelsOutput(stdout);
        return { models };
      } catch (e) {
        lastError = e;
      }
    }

    try {
      throw lastError ?? new Error('Cursor Agent CLI not found');
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

  app.get('/system/mcp-config', async () => {
    return buildMcpConfigResponse();
  });

  // MCP 上下文检测：托管 Agent 使用 credential 绑定身份，手动 MCP 才回退到 query/cwd 推断。
  app.get('/system/workspace-context', async (request, reply) => {
    const { path: cwdPath, sessionId } = request.query as { path?: string; sessionId?: string };
    if (!cwdPath) {
      reply.code(400);
      return { error: 'path query parameter is required' };
    }

    const agentIdentity = request.agentTowerAgentIdentity;
    const effectiveSessionId = agentIdentity?.sessionId ?? sessionId;
    const workspaceFromSession = effectiveSessionId
      ? await prisma.session.findUnique({
          where: { id: effectiveSessionId },
          include: { workspace: { include: { task: { include: { project: true } } } } },
        })
      : null;

    let workspace = workspaceFromSession?.workspace ?? null;
    if (!workspace && !agentIdentity) {
      workspace = await prisma.workspace.findFirst({
        where: {
          status: 'ACTIVE',
          OR: [
            { workingDir: cwdPath },
            { worktreePath: cwdPath },
          ],
        },
        include: { task: { include: { project: true } } },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      });
    }

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
      workspaceKind: workspace.workspaceKind,
      workingDir: workspace.workingDir || workspace.worktreePath,
      ...(agentIdentity
        ? await resolveBoundTeamRunContext(workspace.id, agentIdentity)
        : await resolveTeamRunContext(workspace.id, sessionId)),
    };
  });
}

async function resolveBoundTeamRunContext(workspaceId: string, identity: {
  sessionId: string;
  invocationId: string | null;
}): Promise<{
  teamRunId?: string;
  memberId?: string;
  invocationId?: string;
}> {
  if (!identity.invocationId) return {};

  const invocation = await prisma.agentInvocation.findFirst({
    where: {
      id: identity.invocationId,
      workspaceId,
      sessionId: identity.sessionId,
    },
    select: { id: true, teamRunId: true, memberId: true },
  });
  return invocation ? toTeamRunContext(invocation) : {};
}

async function resolveTeamRunContext(workspaceId: string, sessionId?: string): Promise<{
  teamRunId?: string;
  memberId?: string;
  invocationId?: string;
}> {
  if (sessionId) {
    const invocation = await prisma.agentInvocation.findFirst({
      where: { workspaceId, sessionId },
      select: { id: true, teamRunId: true, memberId: true },
    });
    if (invocation) {
      return toTeamRunContext(invocation);
    }
  }

  const runningInvocations = await prisma.agentInvocation.findMany({
    where: {
      workspaceId,
      status: { in: ['RUNNING', 'SESSION_ENDED', 'WAITING_ROOM_REPLY'] },
    },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    take: 2,
    select: { id: true, teamRunId: true, memberId: true },
  });

  if (runningInvocations.length !== 1) {
    return {};
  }

  return toTeamRunContext(runningInvocations[0]!);
}

function toTeamRunContext(invocation: {
  id: string;
  teamRunId: string;
  memberId: string;
}): {
  teamRunId: string;
  memberId: string;
  invocationId: string;
} {
  return {
    teamRunId: invocation.teamRunId,
    memberId: invocation.memberId,
    invocationId: invocation.id,
  };
}
