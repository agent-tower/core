import { prisma } from '../utils/index.js';
import { AgentType, SessionStatus } from '../types/index.js';
import { ProcessManager } from '../process/process.manager.js';
import { getExecutor } from '../executors/index.js';

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

    const spawnResult = await executor.spawn({
      workingDir: session.workspace.worktreePath,
      prompt: session.prompt,
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

    this.processManager.track(id, spawnResult.pty);

    return session;
  }

  async stop(id: string) {
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) {
      return null;
    }

    this.processManager.kill(id);

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
