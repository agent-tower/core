import { prisma } from '../utils/index.js';
import type { Prisma } from '@prisma/client';
import { AgentType, SessionStatus, SessionPurpose, TaskStatus, SessionContext } from '../types/index.js';
import { getExecutor, getExecutorByProvider, getProviderById, ExecutionEnv } from '../executors/index.js';
import { filterAgentSubprocessExternalEnv } from '../executors/execution-env.js';
import {
  sessionMsgStoreManager,
  createClaudeCodeParser,
  createCursorAgentParser,
  createCodexParser,
  createUserMessage,
  addNormalizedEntry,
} from '../output/index.js';
import type { NormalizedConversation } from '../output/index.js';
import type { SpawnedChild, CancellationToken } from '../executors/index.js';
import { AgentPipeline, type OutputParser } from '../pipeline/agent-pipeline.js';
import { execGit } from '../git/git-cli.js';
import type { EventBus } from '../core/event-bus.js';
import { getCommitMessageService } from '../core/container.js';
import { TeamReconcilerService } from './team-reconciler.service.js';
import { NotFoundError } from '../errors.js';
import { ensureTaskNotDeleted } from './deleted-task-guard.js';
import {
  getWorkspaceWorkingDir,
  isMainDirectoryWorkspace,
} from './workspace-kind.js';
import { writeErrorLog } from '../utils/error-log.js';
import { INTERNAL_API_TOKEN_ENV, readInternalApiTokenFromEnv } from '../utils/internal-api-token.js';
import { createHash } from 'node:crypto';

const DEBUG_SNAPSHOT = process.env.DEBUG_SNAPSHOT === 'true';

function hashForLog(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function summarizeTextForLog(value: string): { length: number; sha256: string } {
  return {
    length: Buffer.byteLength(value, 'utf8'),
    sha256: hashForLog(value),
  };
}

/**
 * 判断一个 session:patch 是否代表 agent 侧真实进展。
 *
 * SessionManager.sendMessage()（包括 TeamRun 心跳唤醒）会在本地写入一条 user_message entry 并 emit
 * session:patch。这类本地用户消息绝不能算作成员心跳，否则唤醒会刷新 lastHeartbeatAt 并在下一轮
 * watchdog 扫描中清零计数，使“连续 N 次 + 指数退避”失效。这里过滤掉“仅由 user_message 写入组成”的 patch；
 * 任何其它 op（agent entry 写入/替换、流式 content/metadata 更新等）都视为真实进展。
 */
function isAgentProgressPatch(patch: unknown): boolean {
  if (!Array.isArray(patch) || patch.length === 0) {
    return false;
  }
  return patch.some((op) => {
    const value = (op as { value?: unknown } | null)?.value;
    if (!value || typeof value !== 'object') {
      // 非整条 entry 写入（如对 /entries/N/content 的流式更新）视为 agent 进展。
      return true;
    }
    return (value as { entryType?: string }).entryType !== 'user_message';
  });
}

interface StopSessionOptions {
  skipTeamRunReconcile?: boolean;
}

type SessionExecutionRecord = Prisma.SessionGetPayload<{
  include: {
    workspace: { include: { task: true } };
    conversation: true;
  };
}>;

export class SessionManager {
  private pipelines = new Map<string, AgentPipeline>();
  private pendingSpawns = new Map<string, SpawnedChild>();
  private cancelTokens = new Map<string, CancellationToken>();
  private snapshotFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private snapshotFlushChains = new Map<string, Promise<void>>();
  private pendingSnapshotStatus = new Map<string, SessionStatus>();
  // 每个 session 上次写入 TeamRun 心跳时间戳的时刻，用于节流 lastHeartbeatAt 落库。
  private heartbeatThrottle = new Map<string, number>();
  private readonly teamReconciler: TeamReconcilerService;
  private static readonly SNAPSHOT_DEBOUNCE_MS = 1200;
  private static readonly HEARTBEAT_THROTTLE_MS = 30_000;

  constructor(private readonly eventBus: EventBus, teamReconciler?: TeamReconcilerService) {
    this.teamReconciler = teamReconciler ?? new TeamReconcilerService({
      eventBus,
      sessionMessenger: this,
      // 续催/唤醒统一由 MemberHeartbeatScheduler 轮询驱动；这里关闭内部 setTimeout 避免双驱动重复触发。
      // session 退出时的首次 reconcile（COMPLETED 判定 / 首次补催）仍即时执行，不依赖该定时器。
      scheduleReminders: false,
    });

    // Debounced snapshot persistence: keep DB up-to-date without per-patch writes.
    this.eventBus.on('session:patch', ({ sessionId, patch }) => {
      if (DEBUG_SNAPSHOT) {
        const ops = (patch as Array<{ op?: string; path?: string }>).slice(0, 3)
          .map((p) => `${p.op ?? '?'}:${p.path ?? '?'}`)
          .join(', ');
        console.log(
          `[SessionManager:snapshot] patch sessionId=${sessionId} ops=${(patch as unknown[]).length} [${ops}]`
        );
      }
      this.scheduleSnapshotPersist(sessionId);
      // 仅 agent 侧真实进展用作 TeamRun 成员心跳信号（节流落库）；本地 user_message（含唤醒）被过滤。
      this.maybeRecordTeamRunHeartbeat(sessionId, patch);
    });

    this.eventBus.on('session:exit', ({ sessionId, exitCode }) => {
      const pipeline = this.pipelines.get(sessionId);
      if (DEBUG_SNAPSHOT) {
        console.log(`[SessionManager:snapshot] session:exit sessionId=${sessionId} exitCode=${exitCode} hasPipeline=${Boolean(pipeline)}`);
      }
      if (pipeline) {
        // Must call destroy() to remove MsgStore onPatch/onSessionId listeners.
        // Without this, stale listeners accumulate across send/exit cycles and
        // each subsequent pushPatch() forwards the same patch N times.
        pipeline.destroy();
        this.pipelines.delete(sessionId);
      }
      this.cancelTokens.delete(sessionId);
      this.heartbeatThrottle.delete(sessionId);
      this.handleSessionExit(sessionId, exitCode).catch((error) => {
        console.error(`[SessionManager] post-exit handling failed for ${sessionId}:`, error);
        writeErrorLog({
          level: 'error',
          source: 'session.postExit',
          message: `Post-exit handling failed for session ${sessionId}`,
          error,
          metadata: { sessionId, exitCode },
        });
      });
    });

    // NOTE: checkTaskAutoRevert is called directly (awaited) inside start()
    // and sendMessage() to guarantee the task status is updated before the
    // HTTP response is sent. A fire-and-forget EventBus listener here caused
    // a race: the frontend refetch would see stale TODO status because the
    // DB update hadn't completed yet.
  }

  async findById(id: string) {
    return prisma.session.findUnique({
      where: { id },
      include: { processes: true, workspace: true, conversation: true },
    });
  }

  async create(workspaceId: string, agentType: AgentType, prompt: string, variant: string = 'DEFAULT', providerId?: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { task: true },
    });
    if (!workspace) {
      throw new NotFoundError('Workspace', workspaceId);
    }
    ensureTaskNotDeleted(workspace.task);

    return prisma.session.create({
      data: {
        workspaceId,
        context: SessionContext.WORKSPACE,
        agentType,
        variant,
        providerId: providerId ?? null,
        prompt,
        status: SessionStatus.PENDING,
      },
    });
  }

  async start(id: string) {
    console.log('[SessionManager] 🚀 Starting session:', id);

    const session = await this.findSessionExecutionRecord(id);
    if (!session) {
      console.log('[SessionManager] ❌ Session not found:', id);
      return null;
    }
    this.ensureExecutionRecordIsLive(session);
    const workingDir = this.getExecutionWorkingDir(session);

    console.log('[SessionManager] Session details:', {
      id: session.id,
      agentType: session.agentType,
      variant: session.variant,
      prompt: summarizeTextForLog(session.prompt),
      workingDir,
    });

    const agentType = session.agentType as AgentType;
    const executor = session.providerId
      ? getExecutorByProvider(session.providerId)
      : getExecutor(agentType, session.variant ?? 'DEFAULT');
    if (!executor) {
      throw new Error(`Executor not found for agent type: ${session.agentType}${session.providerId ? ` (provider: ${session.providerId})` : ''}`);
    }

    console.log('[SessionManager] ✅ Executor found, spawning process...');

    const env = ExecutionEnv.default(workingDir);

    // 如果有 provider，注入 provider 的环境变量
    if (session.providerId) {
      const provider = getProviderById(session.providerId);
      if (provider && Object.keys(provider.env).length > 0) {
        env.merge(filterAgentSubprocessExternalEnv(provider.env));
      }
    }

    this.injectAgentTowerMcpServiceEnv(env);
    if (!this.isConversationSession(session)) {
      await this.injectTeamRunInvocationEnv(id, env);
    }

    let spawnResult: SpawnedChild;
    try {
      spawnResult = await executor.spawn({
        workingDir,
        prompt: session.prompt,
        env,
      });
    } catch (error) {
      this.logSessionError('session.spawn', error, {
        sessionId: id,
        agentType: session.agentType,
        providerId: session.providerId,
        workingDir,
      });
      throw error;
    }

    await this.registerSpawnedSessionIfTaskLive(id, spawnResult);
    this.attachPipeline(id, agentType, workingDir, spawnResult);
    this.pendingSpawns.delete(id);
    this.eventBus.emit('session:started', { sessionId: id });
    await this.checkTaskAutoRevert(id);
    return session;
  }

  async startFollowUp(id: string, resumeFromSessionId: string) {
    console.log('[SessionManager] 🚀 Starting follow-up session:', id);
    console.log('[SessionManager] Resume from Tower session:', resumeFromSessionId);

    const session = await this.findSessionExecutionRecord(id);
    if (!session) {
      console.log('[SessionManager] ❌ Session not found:', id);
      return null;
    }
    this.ensureExecutionRecordIsLive(session);

    const resumeFromSession = await prisma.session.findUnique({
      where: { id: resumeFromSessionId },
      select: { logSnapshot: true },
    });
    const agentSessionId = resumeFromSession
      ? this.resolveAgentSessionId(resumeFromSessionId, resumeFromSession.logSnapshot)
      : null;

    console.log('[SessionManager] Follow-up session details:', {
      id: session.id,
      resumeFromSessionId,
      agentSessionId,
      agentType: session.agentType,
      variant: session.variant,
      prompt: summarizeTextForLog(session.prompt),
      workingDir: this.getExecutionWorkingDir(session),
    });

    const agentType = session.agentType as AgentType;
    const executor = session.providerId
      ? getExecutorByProvider(session.providerId)
      : getExecutor(agentType, session.variant ?? 'DEFAULT');
    if (!executor) {
      throw new Error(`Executor not found for agent type: ${session.agentType}${session.providerId ? ` (provider: ${session.providerId})` : ''}`);
    }

    const workingDir = this.getExecutionWorkingDir(session);
    const env = ExecutionEnv.default(workingDir);

    if (session.providerId) {
      const provider = getProviderById(session.providerId);
      if (provider && Object.keys(provider.env).length > 0) {
        env.merge(filterAgentSubprocessExternalEnv(provider.env));
      }
    }

    this.injectAgentTowerMcpServiceEnv(env);
    if (!this.isConversationSession(session)) {
      await this.injectTeamRunInvocationEnv(id, env);
    }

    const spawnConfig = {
      workingDir,
      prompt: session.prompt,
      env,
    };

    let spawnResult: SpawnedChild;
    if (agentSessionId && executor.spawnFollowUp) {
      try {
        spawnResult = await executor.spawnFollowUp(spawnConfig, agentSessionId);
      } catch (error) {
        console.warn(
          `[SessionManager] Follow-up spawn failed for ${id}, falling back to a new agent session:`,
          error instanceof Error ? error.message : error
        );
        writeErrorLog({
          level: 'warn',
          source: 'session.spawnFollowUpResume',
          message: `Follow-up spawn failed for session ${id}; falling back to a new agent session`,
          error,
          metadata: {
            sessionId: id,
            resumeFromSessionId,
            agentType: session.agentType,
            providerId: session.providerId,
            workingDir,
          },
        });
        try {
          spawnResult = await executor.spawn(spawnConfig);
        } catch (fallbackError) {
          this.logSessionError('session.spawnFollowUpFallback', fallbackError, {
            sessionId: id,
            resumeFromSessionId,
            agentType: session.agentType,
            providerId: session.providerId,
            workingDir,
          });
          throw fallbackError;
        }
      }
    } else {
      try {
        spawnResult = await executor.spawn(spawnConfig);
      } catch (error) {
        this.logSessionError('session.spawnFollowUp', error, {
          sessionId: id,
          resumeFromSessionId,
          agentType: session.agentType,
          providerId: session.providerId,
          workingDir,
        });
        throw error;
      }
    }

    await this.registerSpawnedSessionIfTaskLive(id, spawnResult);
    this.attachPipeline(id, agentType, workingDir, spawnResult);
    this.pendingSpawns.delete(id);
    this.eventBus.emit('session:started', { sessionId: id });
    await this.checkTaskAutoRevert(id);
    return session;
  }

  async sendMessage(id: string, message: string, providerId?: string) {
    console.log('[SessionManager] 📨 Sending message to session:', id);
    console.log('[SessionManager] Message summary:', summarizeTextForLog(message));
    if (providerId) {
      console.log('[SessionManager] Switching provider to:', providerId);
    }

    const session = await this.findSessionExecutionRecord(id);
    if (!session) {
      console.log('[SessionManager] ❌ Session not found:', id);
      return null;
    }
    this.ensureExecutionRecordIsLive(session);

    // 如果传入了新的 providerId，验证并切换
    if (providerId && providerId !== session.providerId) {
      const newProvider = getProviderById(providerId);
      if (!newProvider) {
        throw new Error(`Provider not found: ${providerId}`);
      }
      // 验证 provider 的 agentType 与 session 一致（仅支持同 agentType 内切换）
      if (String(newProvider.agentType) !== session.agentType) {
        throw new Error(
          `Cannot switch provider: agentType mismatch. Session uses '${session.agentType}', but provider '${newProvider.name}' is for '${newProvider.agentType}'`
        );
      }
      // 持久化切换后的 providerId
      await prisma.session.update({
        where: { id },
        data: { providerId },
      });
      console.log(`[SessionManager] ✅ Provider switched to: ${newProvider.name} (${providerId})`);
    }

    const existing = this.pipelines.get(id);
    if (existing) {
      // Checkpoint snapshot before replacing PTY pipeline.
      if (DEBUG_SNAPSHOT) {
        console.log(`[SessionManager:snapshot] sendMessage checkpoint before pipeline replace sessionId=${id}`);
      }
      await this.flushSnapshotPersist(id);
      existing.destroy();
      this.pipelines.delete(id);
      this.cancelTokens.delete(id);
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

    // Heal index drift caused by previously failed patches (e.g. invalid value).
    // If entryIndex is ahead of snapshot length, subsequent add/replace paths
    // become out-of-bounds and all later patches fail.
    const preflightSnapshot = msgStore.getSnapshot();
    const expectedIndex = preflightSnapshot.entries.length;
    const currentIndex = msgStore.entryIndex.current();
    if (currentIndex !== expectedIndex) {
      if (DEBUG_SNAPSHOT) {
        console.warn(
          `[SessionManager:snapshot] rebase entryIndex sessionId=${id} currentIndex=${currentIndex} expectedIndex=${expectedIndex}`
        );
      }
      msgStore.entryIndex.startFrom(expectedIndex);
    }

    const userEntry = createUserMessage(message);
    const userIndex = msgStore.entryIndex.next();
    const userPatch = addNormalizedEntry(userIndex, userEntry);
    if (DEBUG_SNAPSHOT) {
      console.log(
        `[SessionManager:snapshot] sendMessage userPatch sessionId=${id} index=${userIndex} currentIndex=${msgStore.entryIndex.current()}`
      );
    }
    const userPatchSeq = msgStore.pushPatch(userPatch);
    // Emit directly to EventBus — the old pipeline was already destroyed so
    // MsgStore's patchListeners are empty at this point. Without this line
    // the user-message patch would never reach WebSocket subscribers.
    this.eventBus.emit('session:patch', { sessionId: id, patch: userPatch, seq: userPatchSeq });

    const agentSessionId = this.resolveAgentSessionId(id, session.logSnapshot);
    const agentType = session.agentType as AgentType;
    // 优先使用传入的 providerId，否则使用 session 中的 providerId
    const effectiveProviderId = providerId ?? session.providerId ?? undefined;
    const executor = effectiveProviderId
      ? getExecutorByProvider(effectiveProviderId)
      : getExecutor(agentType, session.variant ?? 'DEFAULT');
    if (!executor) {
      throw new Error(`Executor not found for agent type: ${session.agentType}${effectiveProviderId ? ` (provider: ${effectiveProviderId})` : ''}`);
    }

    const workingDir = this.getExecutionWorkingDir(session);
    const env = ExecutionEnv.default(workingDir);

    // 如果有 provider，注入 provider 的环境变量
    if (effectiveProviderId) {
      const provider = getProviderById(effectiveProviderId);
      if (provider && Object.keys(provider.env).length > 0) {
        env.merge(filterAgentSubprocessExternalEnv(provider.env));
      }
    }

    this.injectAgentTowerMcpServiceEnv(env);
    if (!this.isConversationSession(session)) {
      await this.injectTeamRunInvocationEnv(id, env);
    }

    const spawnConfig = {
      workingDir,
      prompt: message,
      env,
    };

    let spawnResult: SpawnedChild;
    if (agentSessionId && executor.spawnFollowUp) {
      try {
        spawnResult = await executor.spawnFollowUp(spawnConfig, agentSessionId);
      } catch (resumeError) {
        writeErrorLog({
          level: 'warn',
          source: 'session.messageSpawnResume',
          message: `Message follow-up spawn failed for session ${id}; falling back to a new agent session`,
          error: resumeError,
          metadata: {
            sessionId: id,
            agentType: session.agentType,
            providerId: effectiveProviderId,
            workingDir,
          },
        });
        try {
          spawnResult = await executor.spawn(spawnConfig);
        } catch (error) {
          this.logSessionError('session.messageSpawnFallback', error, {
            sessionId: id,
            agentType: session.agentType,
            providerId: effectiveProviderId,
            workingDir,
          });
          throw error;
        }
      }
    } else {
      try {
        spawnResult = await executor.spawn(spawnConfig);
      } catch (error) {
        this.logSessionError('session.messageSpawn', error, {
          sessionId: id,
          agentType: session.agentType,
          providerId: effectiveProviderId,
          workingDir,
        });
        throw error;
      }
    }

    await this.registerSpawnedSessionIfTaskLive(id, spawnResult);
    this.attachPipeline(id, agentType, workingDir, spawnResult);
    this.pendingSpawns.delete(id);
    this.eventBus.emit('session:started', { sessionId: id });
    await this.checkTaskAutoRevert(id);
    return session;
  }

  async stop(id: string, options: StopSessionOptions = {}) {
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) return null;

    const pendingSpawn = this.pendingSpawns.get(id);
    if (pendingSpawn) {
      this.pendingSpawns.delete(id);
      try {
        pendingSpawn.cancel?.cancel();
      } catch {
        // ignore cancellation failures for pending spawns
      }
      try {
        pendingSpawn.pty.kill();
      } catch {
        // ignore kill errors for pending spawns
      }
    }

    const pipeline = this.pipelines.get(id);
    if (pipeline) {
      // Try graceful shutdown via SIGINT first
      const cancel = this.cancelTokens.get(id);
      if (cancel) {
        cancel.cancel();
      }
      pipeline.destroy();
      this.pipelines.delete(id);
      this.cancelTokens.delete(id);
    }

    const msgStore = sessionMsgStoreManager.get(id);
    if (msgStore) {
      msgStore.pushFinished();
      try {
        await this.flushSnapshotPersist(id, SessionStatus.CANCELLED);
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

    if (!options.skipTeamRunReconcile && !this.isConversationSession(session)) {
      await this.teamReconciler.handleSessionStopped(id);
    }
    this.eventBus.emit('session:stopped', { sessionId: id });
    // stop() 路径不会触发 session:exit（pipeline.destroy 先于 PTY 退出，
    // onExit 被 destroyed 标志短路），handleSessionExit 不会执行，
    // 因此在这里释放 MsgStore。快照已在上方持久化（CANCELLED）。
    sessionMsgStoreManager.delete(id);
    return session;
  }

  /**
   * 是否仍持有该 session 的活跃 PTY pipeline。
   * 供 TeamRun 心跳 watchdog 判断 invocation 是真卡死（pipeline 存活）还是孤儿（进程已脱管）。
   */
  hasActivePipeline(sessionId: string): boolean {
    return this.pipelines.has(sessionId);
  }

  /**
   * 节流写入 TeamRun invocation 的心跳时间戳。非 TeamRun session 无对应 invocation，updateMany 命中 0 行无副作用。
   */
  private maybeRecordTeamRunHeartbeat(sessionId: string, patch: unknown): void {
    // 过滤掉本地 user_message patch（含心跳唤醒注入的消息），只让 agent 真实进展刷新心跳。
    if (!isAgentProgressPatch(patch)) {
      return;
    }
    const now = Date.now();
    const last = this.heartbeatThrottle.get(sessionId) ?? 0;
    if (now - last < SessionManager.HEARTBEAT_THROTTLE_MS) {
      return;
    }
    this.heartbeatThrottle.set(sessionId, now);
    this.teamReconciler.recordHeartbeat(sessionId).catch((error) => {
      console.warn(
        `[SessionManager] Failed to record TeamRun heartbeat for ${sessionId}:`,
        error instanceof Error ? error.message : error
      );
    });
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

  /**
   * Destroy all active pipelines. Called on graceful server shutdown.
   */
  destroyAll(): void {
    if (this.pipelines.size === 0) return;
    console.log(`[SessionManager] Destroying all ${this.pipelines.size} active pipelines`);
    for (const [sessionId, pipeline] of this.pipelines) {
      const cancel = this.cancelTokens.get(sessionId);
      if (cancel) {
        cancel.cancel();
      }
      pipeline.destroy();
    }
    this.pipelines.clear();
    this.cancelTokens.clear();
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
    if (spawnResult.cancel) {
      this.cancelTokens.set(sessionId, spawnResult.cancel);
    }
  }

  private async registerSpawnedSessionIfTaskLive(
    sessionId: string,
    spawnResult: SpawnedChild,
  ): Promise<void> {
    this.pendingSpawns.set(sessionId, spawnResult);
    try {
      await prisma.$transaction(async (tx) => {
        const session = await tx.session.findUnique({
          where: { id: sessionId },
          include: { workspace: { include: { task: true } }, conversation: true },
        });
        if (!session) {
          throw new NotFoundError('Session', sessionId);
        }

        if (this.isConversationSession(session)) {
          if (!session.conversation || session.conversation.deletedAt) {
            throw new NotFoundError('Conversation', session.conversationId ?? sessionId);
          }
        } else {
          if (!session.workspace) {
            throw new NotFoundError('Workspace', session.workspaceId ?? sessionId);
          }
          ensureTaskNotDeleted(session.workspace.task);
        }

        await tx.session.update({
          where: { id: sessionId },
          data: { status: SessionStatus.RUNNING },
        });

        await tx.executionProcess.create({
          data: {
            sessionId,
            pid: spawnResult.pid,
          },
        });
      });
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: { workspace: { include: { task: true } }, conversation: true },
      });
      if (!session) {
        throw new NotFoundError('Session', sessionId);
      }
      if (this.isConversationSession(session)) {
        if (!session.conversation || session.conversation.deletedAt) {
          throw new NotFoundError('Conversation', session.conversationId ?? sessionId);
        }
      } else {
        if (!session.workspace) {
          throw new NotFoundError('Workspace', session.workspaceId ?? sessionId);
        }
        ensureTaskNotDeleted(session.workspace.task);
      }
      if (this.pendingSpawns.get(sessionId) !== spawnResult) {
        throw new NotFoundError(
          this.isConversationSession(session) ? 'Conversation' : 'Task',
          this.isConversationSession(session)
            ? (session.conversationId ?? sessionId)
            : (session.workspace?.task.id ?? sessionId),
        );
      }
    } catch (error) {
      await this.cancelSpawnedSession(sessionId, spawnResult);
      throw error;
    }
  }

  private async cancelSpawnedSession(
    sessionId: string,
    spawnResult: SpawnedChild,
  ): Promise<void> {
    if (this.pendingSpawns.get(sessionId) === spawnResult) {
      this.pendingSpawns.delete(sessionId);
    }
    const pipeline = this.pipelines.get(sessionId);
    if (pipeline) {
      pipeline.destroy();
      this.pipelines.delete(sessionId);
      this.cancelTokens.delete(sessionId);
    }
    try {
      spawnResult.cancel?.cancel();
    } catch {
      // ignore cancellation failures while compensating a deleted task race
    }
    try {
      spawnResult.pty.kill();
    } catch {
      // ignore kill failures while compensating a deleted task race
    }
    await prisma.session.update({
      where: { id: sessionId },
      data: { status: SessionStatus.CANCELLED },
    }).catch(() => {
      // session may already have been removed by cleanup
    });
    await prisma.executionProcess.deleteMany({
      where: { sessionId, pid: spawnResult.pid },
    }).catch(() => {
      // process row may not have been created yet
    });
    // 补偿路径同样释放 MsgStore（sendMessage 在 spawn 前已 getOrCreate）
    sessionMsgStoreManager.delete(sessionId);
  }

  private createParser(agentType: AgentType, workingDir: string, msgStore: ReturnType<typeof sessionMsgStoreManager.getOrCreate>): OutputParser | null {
    if (agentType === AgentType.CLAUDE_CODE) {
      return createClaudeCodeParser(msgStore);
    }
    if (agentType === AgentType.CURSOR_AGENT) {
      return createCursorAgentParser(msgStore, workingDir);
    }
    if (agentType === AgentType.CODEX) {
      return createCodexParser(msgStore);
    }
    return null;
  }

  private injectAgentTowerMcpServiceEnv(env: ExecutionEnv): void {
    const serviceEnv: Record<string, string> = {};
    if (process.env.AGENT_TOWER_URL) {
      serviceEnv.AGENT_TOWER_URL = process.env.AGENT_TOWER_URL;
    }
    if (process.env.AGENT_TOWER_PORT) {
      serviceEnv.AGENT_TOWER_PORT = process.env.AGENT_TOWER_PORT;
    }
    const internalToken = readInternalApiTokenFromEnv();
    if (internalToken) {
      serviceEnv[INTERNAL_API_TOKEN_ENV] = internalToken;
    }
    if (Object.keys(serviceEnv).length > 0) {
      env.merge(serviceEnv);
    }
  }

  private async injectTeamRunInvocationEnv(sessionId: string, env: ExecutionEnv): Promise<void> {
    const invocation = await prisma.agentInvocation.findFirst({
      where: { sessionId },
      select: {
        id: true,
        teamRunId: true,
        memberId: true,
        targetPort: true,
        targetVitePort: true,
        targetE2EPort: true,
      },
    });

    if (!invocation) {
      return;
    }

    env.merge({
      AGENT_TOWER_SESSION_ID: sessionId,
      AGENT_TOWER_INVOCATION_ID: invocation.id,
      AGENT_TOWER_TEAM_RUN_ID: invocation.teamRunId,
      AGENT_TOWER_MEMBER_ID: invocation.memberId,
    });

    const portEnv: Record<string, string> = {};
    if (invocation.targetPort != null) {
      portEnv.PORT = String(invocation.targetPort);
    }
    if (invocation.targetVitePort != null) {
      portEnv.VITE_PORT = String(invocation.targetVitePort);
    }
    if (invocation.targetE2EPort != null) {
      portEnv.E2E_PORT = String(invocation.targetE2EPort);
    }
    if (Object.keys(portEnv).length > 0) {
      env.merge(portEnv);
    }
  }

  /**
   * Agent 进程退出后自动提交未保存的变更。
   * 保证 worktree 始终干净的兜底机制，最终会被 squash merge 合并。
   * 参考: vibe-kanban crates/local-deployment/src/container.rs:496-505
   */
  private async autoCommitChanges(sessionId: string): Promise<void> {
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: { workspace: true },
      });
      if (!session?.workspace || isMainDirectoryWorkspace(session.workspace)) return;
      if (!session.workspace.worktreePath) return;

      const worktreePath = session.workspace.worktreePath;

      const status = await execGit(worktreePath, ['status', '--porcelain']);
      if (!status.trim()) return;

      await execGit(worktreePath, ['add', '-A']);
      await execGit(worktreePath, [
        'commit', '-m',
        `auto-commit: uncommitted changes from session ${sessionId.slice(0, 8)}`,
      ]);

      console.log(`[SessionManager] Auto-committed changes for session ${sessionId}`);
    } catch (error) {
      // auto-commit 失败不应阻断后续流程
      console.warn(
        `[SessionManager] Auto-commit failed for session ${sessionId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  private async persistCompletedSnapshot(sessionId: string): Promise<void> {
    await this.flushSnapshotPersist(sessionId, SessionStatus.COMPLETED);
  }

  private scheduleSnapshotPersist(sessionId: string, status?: SessionStatus): void {
    if (status) {
      this.pendingSnapshotStatus.set(sessionId, status);
    }
    const timer = this.snapshotFlushTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
    }
    const nextTimer = setTimeout(() => {
      this.snapshotFlushTimers.delete(sessionId);
      if (DEBUG_SNAPSHOT) {
        console.log(`[SessionManager:snapshot] debounce fire sessionId=${sessionId}`);
      }
      this.flushSnapshotPersist(sessionId).catch((error) => {
        console.error(`[SessionManager] Debounced snapshot persist failed for ${sessionId}:`, error);
      });
    }, SessionManager.SNAPSHOT_DEBOUNCE_MS);
    this.snapshotFlushTimers.set(sessionId, nextTimer);
    if (DEBUG_SNAPSHOT) {
      console.log(
        `[SessionManager:snapshot] debounce scheduled sessionId=${sessionId} ms=${SessionManager.SNAPSHOT_DEBOUNCE_MS} status=${status ?? 'none'}`
      );
    }
  }

  private async flushSnapshotPersist(sessionId: string, status?: SessionStatus): Promise<void> {
    if (status) {
      this.pendingSnapshotStatus.set(sessionId, status);
    }
    const timer = this.snapshotFlushTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.snapshotFlushTimers.delete(sessionId);
    }

    const previous = this.snapshotFlushChains.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // Keep the chain alive even if previous flush failed.
      })
      .then(async () => {
        const pendingStatus = this.pendingSnapshotStatus.get(sessionId);
        this.pendingSnapshotStatus.delete(sessionId);
        if (DEBUG_SNAPSHOT) {
          console.log(
            `[SessionManager:snapshot] flush start sessionId=${sessionId} pendingStatus=${pendingStatus ?? 'none'}`
          );
        }

        const msgStore = sessionMsgStoreManager.get(sessionId);
        if (!msgStore) {
          if (DEBUG_SNAPSHOT) {
            console.log(`[SessionManager:snapshot] flush no-msgStore sessionId=${sessionId}`);
          }
          if (pendingStatus) {
            await prisma.session.update({
              where: { id: sessionId },
              data: { status: pendingStatus },
            });
            if (DEBUG_SNAPSHOT) {
              console.log(
                `[SessionManager:snapshot] flush status-only persisted sessionId=${sessionId} status=${pendingStatus}`
              );
            }
          }
          return;
        }

        const snapshot = msgStore.getSnapshot();
        const tokenUsage = this.extractTokenUsageFromSnapshot(snapshot);
        if (DEBUG_SNAPSHOT) {
          const msgCount = msgStore.getMessages().length;
          const nextIndex = msgStore.entryIndex.current();
          console.log(
            `[SessionManager:snapshot] flush snapshot sessionId=${sessionId} entries=${snapshot.entries.length} msgCount=${msgCount} nextIndex=${nextIndex} tokenUsage=${tokenUsage ? 'yes' : 'no'}`
          );
        }

        if (pendingStatus) {
          await prisma.session.update({
            where: { id: sessionId },
            data: {
              status: pendingStatus,
              logSnapshot: JSON.stringify(snapshot),
              ...(tokenUsage ? { tokenUsage: JSON.stringify(tokenUsage) } : {}),
            },
          });
          if (DEBUG_SNAPSHOT) {
            console.log(
              `[SessionManager:snapshot] flush persisted sessionId=${sessionId} status=${pendingStatus} entries=${snapshot.entries.length}`
            );
          }
          return;
        }

        await prisma.session.update({
          where: { id: sessionId },
          data: {
            logSnapshot: JSON.stringify(snapshot),
            ...(tokenUsage ? { tokenUsage: JSON.stringify(tokenUsage) } : {}),
          },
        });
        if (DEBUG_SNAPSHOT) {
          console.log(
            `[SessionManager:snapshot] flush persisted sessionId=${sessionId} status=unchanged entries=${snapshot.entries.length}`
          );
        }
      });

    this.snapshotFlushChains.set(sessionId, current);
    try {
      await current;
    } finally {
      if (this.snapshotFlushChains.get(sessionId) === current) {
        this.snapshotFlushChains.delete(sessionId);
      }
    }
  }

  private extractTokenUsageFromSnapshot(snapshot: NormalizedConversation): { totalTokens: number; modelContextWindow?: number } | null {
    for (let i = snapshot.entries.length - 1; i >= 0; i--) {
      const entry = snapshot.entries[i];
      if (entry.entryType === 'token_usage_info' && entry.metadata?.tokenUsage?.totalTokens != null) {
        return entry.metadata.tokenUsage as { totalTokens: number; modelContextWindow?: number };
      }
    }
    return null;
  }

  private async findSessionExecutionRecord(sessionId: string) {
    return prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        workspace: { include: { task: true } },
        conversation: true,
      },
    });
  }

  private isConversationSession(session: { context?: string | null; conversationId?: string | null }): boolean {
    return session.context === SessionContext.CONVERSATION || Boolean(session.conversationId);
  }

  private ensureExecutionRecordIsLive(session: SessionExecutionRecord): void {
    if (this.isConversationSession(session)) {
      if (!session.conversation || session.conversation.deletedAt) {
        throw new NotFoundError('Conversation', session.conversationId ?? session.id);
      }
      return;
    }

    if (!session.workspace) {
      throw new NotFoundError('Workspace', session.workspaceId ?? session.id);
    }
    ensureTaskNotDeleted(session.workspace.task);
  }

  private getExecutionWorkingDir(session: SessionExecutionRecord): string {
    if (this.isConversationSession(session)) {
      if (!session.conversation) {
        throw new NotFoundError('Conversation', session.conversationId ?? session.id);
      }
      return session.conversation.workingDir;
    }

    if (!session.workspace) {
      throw new NotFoundError('Workspace', session.workspaceId ?? session.id);
    }
    return getWorkspaceWorkingDir(session.workspace);
  }

  /**
   * Session 完成后检查 Task 是否可以自动推进状态。
   *
   * 规则：当一个 Task 下所有 Workspace 的所有 CHAT Session 都处于终态
   * （COMPLETED / CANCELLED / FAILED）时，自动将 IN_PROGRESS 的 Task
   * 推进到 IN_REVIEW，提示用户进行代码审查。
   * 同时触发 commit message 的后台生成。
   */
  private async checkTaskAutoAdvance(sessionId: string): Promise<void> {
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: { workspace: { include: { task: true } } },
      });
      if (!session?.workspace?.task) return;

      const task = session.workspace.task;
      if (task.deletedAt) return;
      // 只对 IN_PROGRESS 的 Task 做自动推进
      if (task.status !== TaskStatus.IN_PROGRESS) return;

      // 查询该 Task 下所有 CHAT Session（排除 COMMIT_MSG）
      const allSessions = await prisma.session.findMany({
        where: {
          workspace: { taskId: task.id },
          purpose: { not: SessionPurpose.COMMIT_MSG },
        },
        select: { status: true },
      });

      const terminalStatuses: string[] = [SessionStatus.COMPLETED, SessionStatus.CANCELLED, SessionStatus.FAILED];
      const allDone = allSessions.every((s) => terminalStatuses.includes(s.status));

      if (allDone && allSessions.length > 0) {
        await prisma.task.update({
          where: { id: task.id },
          data: { status: TaskStatus.IN_REVIEW },
        });

        this.eventBus.emit('task:updated', {
          taskId: task.id,
          projectId: task.projectId,
          status: TaskStatus.IN_REVIEW,
        });

        console.log(`[SessionManager] Task ${task.id} auto-advanced to IN_REVIEW (all sessions completed)`);
      }
    } catch (error) {
      console.error(`[SessionManager] checkTaskAutoAdvance failed for session ${sessionId}:`, error);
    }
  }

  /**
   * 异步触发 commit message 生成（fire-and-forget）
   */
  private triggerCommitMessageGeneration(workspaceId: string): void {
    const commitMessageService = getCommitMessageService();
    commitMessageService.triggerGeneration(workspaceId).catch((error) => {
      console.warn(
        `[SessionManager] Failed to trigger commit message generation for workspace ${workspaceId}:`,
        error instanceof Error ? error.message : error
      );
    });
  }

  /**
   * Session 启动时自动更新 Task 状态。
   *
   * 规则：
   * 1. TODO → IN_PROGRESS：首次启动 session 时，任务开始进行
   * 2. IN_REVIEW/DONE → IN_PROGRESS：重新启动 session 时，任务回退到进行中
   * 注意：COMMIT_MSG session 启动不应触发状态变更。
   */
  private async checkTaskAutoRevert(sessionId: string): Promise<void> {
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: { workspace: { include: { task: true } } },
      });
      if (!session?.workspace?.task) return;

      // COMMIT_MSG session 不触发状态变更
      if (session.purpose === SessionPurpose.COMMIT_MSG) return;

      const task = session.workspace.task;
      if (task.deletedAt) return;

      // 如果任务已经是 IN_PROGRESS，无需更新
      if (task.status === TaskStatus.IN_PROGRESS) return;

      // TODO、IN_REVIEW、DONE 都应该转为 IN_PROGRESS
      const shouldUpdate = [TaskStatus.TODO, TaskStatus.IN_REVIEW, TaskStatus.DONE].includes(task.status as TaskStatus);
      if (!shouldUpdate) return;

      await prisma.task.update({
        where: { id: task.id },
        data: { status: TaskStatus.IN_PROGRESS },
      });

      this.eventBus.emit('task:updated', {
        taskId: task.id,
        projectId: task.projectId,
        status: TaskStatus.IN_PROGRESS,
      });

      console.log(
        `[SessionManager] Task ${task.id} status updated from ${task.status} to IN_PROGRESS (session ${sessionId} started)`,
      );
    } catch (error) {
      console.error(`[SessionManager] checkTaskAutoRevert failed for session ${sessionId}:`, error);
    }
  }

  /**
   * Session 退出后的统一处理入口。
   * 根据 session purpose 走不同的后处理路径。
   * exitCode 非 0 时标记为 FAILED。
   */
  private async handleSessionExit(sessionId: string, exitCode?: number): Promise<void> {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { purpose: true, context: true, conversationId: true },
    });

    // exitCode 非 0 且非 undefined 视为失败
    const isFailed = typeof exitCode === 'number' && exitCode !== 0;
    const finalStatus = isFailed ? SessionStatus.FAILED : SessionStatus.COMPLETED;

    if (isFailed) {
      console.warn(`[SessionManager] Session ${sessionId} exited with code ${exitCode}, marking as FAILED`);
      writeErrorLog({
        level: 'warn',
        source: 'session.exit',
        message: `Session exited with non-zero code ${exitCode}`,
        metadata: { sessionId, exitCode },
      });
    }

    if (session?.context === SessionContext.CONVERSATION || session?.conversationId) {
      await this.flushSnapshotPersist(sessionId, finalStatus);
      if (session.conversationId) {
        await prisma.conversation.update({
          where: { id: session.conversationId },
          data: { lastActiveAt: new Date() },
        }).catch(() => {
          // Conversation may have been deleted while the process exited.
        });
      }
      this.eventBus.emit('session:completed', { sessionId, status: finalStatus });
    } else if (session?.purpose === SessionPurpose.COMMIT_MSG) {
      // COMMIT_MSG session: 只需持久化快照，然后提取 commit message
      await this.flushSnapshotPersist(sessionId, finalStatus);
      if (!isFailed) {
        try {
          const commitMessageService = getCommitMessageService();
          await commitMessageService.extractAndCache(sessionId);
        } catch (error) {
          console.warn(
            `[SessionManager] Failed to extract commit message from session ${sessionId}:`,
            error instanceof Error ? error.message : error
          );
        }
      }
      // 通知前端 session 状态（DB 状态已更新）
      this.eventBus.emit('session:completed', { sessionId, status: finalStatus });
    } else {
      // 正常 CHAT session: autoCommit → 持久化 → 检查 Task 推进 → 触发 commit message 生成
      if (!isFailed) {
        await this.autoCommitChanges(sessionId);
      }
      await this.flushSnapshotPersist(sessionId, finalStatus);
      // 通知前端 session 状态（DB 状态已更新）
      this.eventBus.emit('session:completed', { sessionId, status: finalStatus });

      const handledByTeamRun = await this.teamReconciler.handleSessionExit(sessionId);

      if (!isFailed) {
        if (!handledByTeamRun) {
          await this.checkTaskAutoAdvance(sessionId);
        }

        // 每次 CHAT session 完成都触发 commit message 重新生成
        const sess = await prisma.session.findUnique({
          where: { id: sessionId },
          select: { workspaceId: true },
        });
        if (sess?.workspaceId) {
          this.triggerCommitMessageGeneration(sess.workspaceId);
        }
      }
    }

    // 释放内存中的 MsgStore，防止单例 Map 随会话数量无限增长（每个最高 100MB）。
    // 此时快照已通过 flushSnapshotPersist 持久化到 DB；后续读取（/logs API、
    // sendMessage 重启、resolveAgentSessionId、commit message 提取）都有
    // logSnapshot fallback，sendMessage 会经 restoreFromSnapshot 恢复上下文。
    sessionMsgStoreManager.delete(sessionId);
  }

  private logSessionError(source: string, error: unknown, metadata: Record<string, unknown>): void {
    writeErrorLog({
      level: 'error',
      source,
      message: error instanceof Error ? error.message : String(error),
      error,
      metadata,
    });
  }
}
