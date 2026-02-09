import { prisma } from '../utils/index.js';
import { AgentType, SessionStatus } from '../types/index.js';
import { getExecutor, ExecutionEnv } from '../executors/index.js';
import { sessionMsgStoreManager, createClaudeCodeParser, createCursorAgentParser } from '../output/index.js';
import type { NormalizedConversation } from '../output/index.js';
import { getProcessManager } from '../socket/handlers/terminal.handler.js';
import type { SpawnedChild } from '../executors/index.js';

export class SessionService {

  async findById(id: string) {
    return prisma.session.findUnique({
      where: { id },
      include: { processes: true, workspace: true },
    });
  }

  async create(workspaceId: string, agentType: AgentType, prompt: string) {
    return prisma.session.create({
      data: {
        workspaceId,
        agentType,
        prompt,
        status: SessionStatus.PENDING,
      },
    });
  }

  async start(id: string) {
    const session = await prisma.session.findUnique({
      where: { id },
      include: { workspace: true },
    });

    if (!session) {
      return null;
    }

    const executor = getExecutor(session.agentType as AgentType);
    if (!executor) {
      throw new Error(`Executor not found for agent type: ${session.agentType}`);
    }

    const workingDir = session.workspace.worktreePath;

    const spawnResult = await executor.spawn({
      workingDir,
      prompt: session.prompt,
      env: ExecutionEnv.default(workingDir),
    });

    await prisma.executionProcess.create({
      data: {
        sessionId: id,
        pid: spawnResult.pid,
      },
    });

    await prisma.session.update({
      where: { id },
      data: { status: SessionStatus.RUNNING },
    });

    this.attachPtyPipeline(id, session.agentType as AgentType, workingDir, spawnResult);

    return session;
  }

  async resume(id: string, prompt: string) {
    // 1. 查询 session（含 workspace），校验存在
    const session = await prisma.session.findUnique({
      where: { id },
      include: { workspace: true },
    });

    if (!session) {
      return null;
    }

    // 2. 校验 session 状态必须为 COMPLETED 或 CANCELLED
    if (session.status !== SessionStatus.COMPLETED && session.status !== SessionStatus.CANCELLED) {
      throw new ResumeError(
        `Cannot resume session with status ${session.status}. Only COMPLETED or CANCELLED sessions can be resumed.`,
        400
      );
    }

    // 3. 获取 executor
    const agentType = session.agentType as AgentType;
    const executor = getExecutor(agentType);
    if (!executor) {
      throw new Error(`Executor not found for agent type: ${session.agentType}`);
    }

    const workingDir = session.workspace.worktreePath;

    // 4. 解析 agentSessionId（agent 内部的 session ID）
    const agentSessionId = this.resolveAgentSessionId(id, session.logSnapshot);

    // 5. spawn：优先 spawnFollowUp，fallback 到 spawn
    const spawnConfig = {
      workingDir,
      prompt,
      env: ExecutionEnv.default(workingDir),
    };

    let spawnResult: SpawnedChild;
    if (agentSessionId && executor.spawnFollowUp) {
      try {
        spawnResult = await executor.spawnFollowUp(spawnConfig, agentSessionId);
      } catch {
        // executor 不支持 spawnFollowUp，fallback 到普通 spawn
        spawnResult = await executor.spawn(spawnConfig);
      }
    } else {
      // 没有 agentSessionId，视为新会话
      spawnResult = await executor.spawn(spawnConfig);
    }

    // 6. 创建新的 executionProcess 记录
    await prisma.executionProcess.create({
      data: {
        sessionId: id,
        pid: spawnResult.pid,
      },
    });

    // 7. 更新 session 状态为 RUNNING
    await prisma.session.update({
      where: { id },
      data: { status: SessionStatus.RUNNING },
    });

    // 8. 清除旧的 MsgStore（如果存在），创建新的 pipeline
    sessionMsgStoreManager.remove(id);
    this.attachPtyPipeline(id, agentType, workingDir, spawnResult);

    return session;
  }

  async stop(id: string) {
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) {
      return null;
    }

    const processManager = getProcessManager();
    processManager.kill(id);

    // 清理 MsgStore
    sessionMsgStoreManager.remove(id);

    await prisma.session.update({
      where: { id },
      data: { status: SessionStatus.CANCELLED },
    });

    return session;
  }

  async sendMessage(id: string, message: string) {
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session || session.status !== SessionStatus.RUNNING) {
      return null;
    }

    const processManager = getProcessManager();
    processManager.write(id, message);
    return session;
  }

  /**
   * 从内存 MsgStore 或数据库 logSnapshot 中解析 agent 内部的 sessionId
   */
  private resolveAgentSessionId(sessionId: string, logSnapshot: string | null): string | null {
    // 优先从内存 MsgStore 获取
    const msgStore = sessionMsgStoreManager.get(sessionId);
    if (msgStore) {
      const snapshot = msgStore.getSnapshot();
      if (snapshot.sessionId) {
        return snapshot.sessionId;
      }
    }

    // 从数据库 logSnapshot JSON 中解析
    if (logSnapshot) {
      try {
        const parsed = JSON.parse(logSnapshot) as NormalizedConversation;
        if (parsed.sessionId) {
          return parsed.sessionId;
        }
      } catch {
        // JSON 解析失败，忽略
      }
    }

    return null;
  }

  /**
   * 将 PTY 输出连接到 MsgStore + Parser pipeline 并注册到 ProcessManager
   * start 和 resume 共用此逻辑
   */
  private attachPtyPipeline(
    sessionId: string,
    agentType: AgentType,
    workingDir: string,
    spawnResult: SpawnedChild
  ): void {
    // 创建 MsgStore
    const msgStore = sessionMsgStoreManager.create(
      sessionId,
      agentType,
      workingDir
    );

    // 根据 agent 类型创建解析器（将原始 PTY stdout 转换为标准化 JSON Patch）
    let parser: { processData(data: string): void; finish(): void } | null = null;
    if (agentType === AgentType.CLAUDE_CODE) {
      parser = createClaudeCodeParser(msgStore);
    } else if (agentType === AgentType.CURSOR_AGENT) {
      parser = createCursorAgentParser(msgStore, workingDir);
    }

    // 将 PTY 输出转发到 MsgStore 和解析器
    spawnResult.pty.onData((data) => {
      msgStore.pushStdout(data);
      if (parser) {
        parser.processData(data);
      }
    });

    // PTY 退出时标记 MsgStore 完成并持久化日志快照
    spawnResult.pty.onExit(async () => {
      if (parser) {
        parser.finish();
      }
      msgStore.pushFinished();

      // 持久化日志快照到数据库
      try {
        const snapshot = msgStore.getSnapshot();
        await prisma.session.update({
          where: { id: sessionId },
          data: {
            status: SessionStatus.COMPLETED,
            logSnapshot: JSON.stringify(snapshot),
          },
        });
      } catch (error) {
        console.error(`[SessionService] Failed to persist log snapshot for session ${sessionId}:`, error);
      }
    });

    // 使用共享的 ProcessManager，使 Socket.IO Terminal handler 能找到 PTY
    const processManager = getProcessManager();
    processManager.track(sessionId, spawnResult.pty);
  }
}

/**
 * Resume 操作专用错误，携带 HTTP 状态码
 */
export class ResumeError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'ResumeError';
  }
}
