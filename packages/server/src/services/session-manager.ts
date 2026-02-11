import { prisma } from '../utils/index.js';
import { AgentType, SessionStatus } from '../types/index.js';
import { getExecutor, ExecutionEnv } from '../executors/index.js';
import {
  sessionMsgStoreManager,
  createClaudeCodeParser,
  createCursorAgentParser,
  createUserMessage,
  addNormalizedEntry,
} from '../output/index.js';
import type { NormalizedConversation } from '../output/index.js';
import type { SpawnedChild } from '../executors/index.js';
import { AgentPipeline, type OutputParser } from '../pipeline/agent-pipeline.js';
import type { EventBus } from '../core/event-bus.js';

export class SessionManager {
  private pipelines = new Map<string, AgentPipeline>();

  constructor(private readonly eventBus: EventBus) {
    this.eventBus.on('session:exit', ({ sessionId }) => {
      const pipeline = this.pipelines.get(sessionId);
      if (!pipeline) return;
      this.pipelines.delete(sessionId);
      this.persistCompletedSnapshot(sessionId).catch((error) => {
        console.error(`[SessionManager] Failed to persist completed snapshot for ${sessionId}:`, error);
      });
    });
  }

  async findById(id: string) {
    return prisma.session.findUnique({
      where: { id },
      include: { processes: true, workspace: true },
    });
  }

  async create(workspaceId: string, agentType: AgentType, prompt: string, variant: string = 'DEFAULT') {
    return prisma.session.create({
      data: {
        workspaceId,
        agentType,
        variant,
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
    if (!session) return null;

    const agentType = session.agentType as AgentType;
    const executor = getExecutor(agentType, session.variant ?? 'DEFAULT');
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

    this.attachPipeline(id, agentType, workingDir, spawnResult);
    this.eventBus.emit('session:started', { sessionId: id });
    return session;
  }

  async sendMessage(id: string, message: string) {
    const session = await prisma.session.findUnique({
      where: { id },
      include: { workspace: true },
    });
    if (!session) return null;

    const existing = this.pipelines.get(id);
    if (existing) {
      existing.destroy();
      this.pipelines.delete(id);
    }

    const isNewStore = !sessionMsgStoreManager.has(id);
    const msgStore = sessionMsgStoreManager.getOrCreate(id);

    if (isNewStore && session.logSnapshot) {
      try {
        const snapshot = JSON.parse(session.logSnapshot) as NormalizedConversation;
        msgStore.restoreFromSnapshot(snapshot);
      } catch (error) {
        console.error(`[SessionManager] Failed to restore snapshot for session ${id}:`, error);
      }
    }

    const userEntry = createUserMessage(message);
    const userPatch = addNormalizedEntry(msgStore.entryIndex.next(), userEntry);
    msgStore.pushPatch(userPatch);
    // Emit directly to EventBus — the old pipeline was already destroyed so
    // MsgStore's patchListeners are empty at this point. Without this line
    // the user-message patch would never reach WebSocket subscribers.
    this.eventBus.emit('session:patch', { sessionId: id, patch: userPatch });

    const agentSessionId = this.resolveAgentSessionId(id, session.logSnapshot);
    const agentType = session.agentType as AgentType;
    const executor = getExecutor(agentType, session.variant ?? 'DEFAULT');
    if (!executor) {
      throw new Error(`Executor not found for agent type: ${session.agentType}`);
    }

    const workingDir = session.workspace.worktreePath;
    const spawnConfig = {
      workingDir,
      prompt: message,
      env: ExecutionEnv.default(workingDir),
    };

    let spawnResult: SpawnedChild;
    if (agentSessionId && executor.spawnFollowUp) {
      try {
        spawnResult = await executor.spawnFollowUp(spawnConfig, agentSessionId);
      } catch {
        spawnResult = await executor.spawn(spawnConfig);
      }
    } else {
      spawnResult = await executor.spawn(spawnConfig);
    }

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

    this.attachPipeline(id, agentType, workingDir, spawnResult);
    this.eventBus.emit('session:started', { sessionId: id });
    return session;
  }

  async stop(id: string) {
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) return null;

    const pipeline = this.pipelines.get(id);
    if (pipeline) {
      pipeline.destroy();
      this.pipelines.delete(id);
    }

    const msgStore = sessionMsgStoreManager.get(id);
    if (msgStore) {
      msgStore.pushFinished();
      try {
        const snapshot = msgStore.getSnapshot();
        await prisma.session.update({
          where: { id },
          data: {
            status: SessionStatus.CANCELLED,
            logSnapshot: JSON.stringify(snapshot),
          },
        });
      } catch (error) {
        console.error(`[SessionManager] Failed to persist cancelled snapshot for ${id}:`, error);
        await prisma.session.update({
          where: { id },
          data: { status: SessionStatus.CANCELLED },
        });
      }
    } else {
      await prisma.session.update({
        where: { id },
        data: { status: SessionStatus.CANCELLED },
      });
    }

    this.eventBus.emit('session:stopped', { sessionId: id });
    return session;
  }

  writeInput(sessionId: string, data: string): void {
    const pipeline = this.pipelines.get(sessionId);
    if (!pipeline) return;
    pipeline.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const pipeline = this.pipelines.get(sessionId);
    if (!pipeline) return;
    pipeline.resize(cols, rows);
  }

  private resolveAgentSessionId(sessionId: string, logSnapshot: string | null): string | null {
    const msgStore = sessionMsgStoreManager.get(sessionId);
    if (msgStore) {
      const snapshot = msgStore.getSnapshot();
      if (snapshot.sessionId) return snapshot.sessionId;
    }

    if (logSnapshot) {
      try {
        const parsed = JSON.parse(logSnapshot) as NormalizedConversation;
        if (parsed.sessionId) return parsed.sessionId;
      } catch {
        // ignore invalid snapshot json
      }
    }
    return null;
  }

  private attachPipeline(
    sessionId: string,
    agentType: AgentType,
    workingDir: string,
    spawnResult: SpawnedChild
  ): void {
    const msgStore = sessionMsgStoreManager.getOrCreate(sessionId);
    const parser = this.createParser(agentType, workingDir, msgStore);
    const pipeline = new AgentPipeline(sessionId, spawnResult.pty, parser, msgStore, this.eventBus);
    this.pipelines.set(sessionId, pipeline);
  }

  private createParser(agentType: AgentType, workingDir: string, msgStore: ReturnType<typeof sessionMsgStoreManager.getOrCreate>): OutputParser | null {
    if (agentType === AgentType.CLAUDE_CODE) {
      return createClaudeCodeParser(msgStore);
    }
    if (agentType === AgentType.CURSOR_AGENT) {
      return createCursorAgentParser(msgStore, workingDir);
    }
    return null;
  }

  private async persistCompletedSnapshot(sessionId: string): Promise<void> {
    const msgStore = sessionMsgStoreManager.get(sessionId);
    if (!msgStore) return;
    const snapshot = msgStore.getSnapshot();
    await prisma.session.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.COMPLETED,
        logSnapshot: JSON.stringify(snapshot),
      },
    });
  }
}
