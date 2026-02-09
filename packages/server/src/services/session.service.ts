import { prisma } from '../utils/index.js';
import { AgentType, SessionStatus } from '../types/index.js';
import { getExecutor, ExecutionEnv } from '../executors/index.js';
import { sessionMsgStoreManager, createClaudeCodeParser, createCursorAgentParser } from '../output/index.js';
import { getProcessManager } from '../socket/handlers/terminal.handler.js';

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

    // 创建 MsgStore 并启动 normalizer
    const msgStore = sessionMsgStoreManager.create(
      id,
      session.agentType as AgentType,
      workingDir
    );

    // 根据 agent 类型创建解析器（将原始 PTY stdout 转换为标准化 JSON Patch）
    let parser: { processData(data: string): void; finish(): void } | null = null;
    const agentType = session.agentType as AgentType;
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
          where: { id },
          data: {
            status: SessionStatus.COMPLETED,
            logSnapshot: JSON.stringify(snapshot),
          },
        });
      } catch (error) {
        console.error(`[SessionService] Failed to persist log snapshot for session ${id}:`, error);
      }
    });

    // 使用共享的 ProcessManager，使 Socket.IO Terminal handler 能找到 PTY
    const processManager = getProcessManager();
    processManager.track(id, spawnResult.pty);

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
}
