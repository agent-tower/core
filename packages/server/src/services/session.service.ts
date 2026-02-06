import { prisma } from '../utils/index.js';
import { AgentType, SessionStatus } from '../types/index.js';
import { ProcessManager } from '../process/process.manager.js';
import { getExecutor, ExecutionEnv } from '../executors/index.js';
import { sessionMsgStoreManager } from '../output/index.js';

export class SessionService {
  private processManager = new ProcessManager();

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

    // 将 PTY 输出转发到 MsgStore
    spawnResult.pty.onData((data) => {
      msgStore.pushStdout(data);
    });

    // PTY 退出时标记 MsgStore 完成
    spawnResult.pty.onExit(() => {
      msgStore.pushFinished();
    });

    this.processManager.track(id, spawnResult.pty);

    return session;
  }

  async stop(id: string) {
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) {
      return null;
    }

    this.processManager.kill(id);

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

    this.processManager.write(id, message);
    return session;
  }
}
