import { prisma } from '../utils/index.js';
import type { Prisma, Session as PrismaSession } from '@prisma/client';
import { AgentType, SessionStatus, SessionPurpose, TaskStatus, SessionContext } from '../types/index.js';
import {
  getProviderById,
  ExecutionEnv,
  isPreChildProcessFailure,
  markPreChildProcessFailure,
  normalizeExecutorStartError,
} from '../executors/index.js';
import { filterAgentSubprocessExternalEnv } from '../executors/execution-env.js';
import {
  sessionMsgStoreManager,
  createUserMessage,
  addNormalizedEntry,
} from '../output/index.js';
import type { NormalizedConversation } from '../output/index.js';
import { execGit } from '../git/git-cli.js';
import type { EventBus } from '../core/event-bus.js';
import { getCommitMessageService } from '../core/container.js';
import { TeamReconcilerService } from './team-reconciler.service.js';
import { acquireTeamMemberAdmission } from './team-member-admission-barrier.js';
import { NotFoundError, ServiceError, ValidationError } from '../errors.js';
import { AgentRuntimeError } from '../runtime/errors.js';
import { ensureTaskNotDeleted } from './deleted-task-guard.js';
import {
  getWorkspaceWorkingDir,
  isMainDirectoryWorkspace,
} from './workspace-kind.js';
import { writeErrorLog } from '../utils/error-log.js';
import {
  AGENT_API_CREDENTIAL_ENV,
  clearAgentApiCredentials,
  createAgentApiCredential,
  revokeAgentApiCredential,
} from '../utils/agent-api-credential.js';
import { createHash, randomUUID } from 'node:crypto';
import { RuntimeType, supportsAgentRuntime, type RuntimeStateDto } from '@agent-tower/shared';
import { getProviderRuntimeType } from '../executors/providers.js';
import { appendAgentOutputIntentInstructions } from '../prompts/agent-output-intents.js';
import { AgentArtifactService } from './agent-artifact.service.js';
import {
  CliRuntimeDriver,
  AcpRuntimeDriver,
  RuntimeCoordinator,
  StaticRuntimeRegistry,
  type RuntimeRegistry,
  type RuntimeStartAdmission,
  setRuntimeStateSnapshot,
  type RuntimeResumeMode,
  type RuntimeProcessEvent,
  type RuntimeTurnEventEnvelope,
} from '../runtime/index.js';
import { buildWorkspaceRuntimePrompt } from '../prompts/workspace-background-service-policy.js';
import {
  cleanupPersistedAcpProcessTree,
  type PersistedAcpProcessIdentity,
} from '../runtime/acp/process-manager.js';
import {
  evaluateSessionRuntimeCleanup,
  RUNTIME_LAUNCH_STATES,
} from './session-runtime-cleanup-gate.js';

const DEBUG_SNAPSHOT = process.env.DEBUG_SNAPSHOT === 'true';
const PROCESS_CLEANUP_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 300_000];
const PENDING_RUNTIME_EVENT_TTL_MS = 60_000;
const PENDING_RUNTIME_EVENTS_PER_KEY = 8;
const PENDING_RUNTIME_EVENTS_GLOBAL = 128;
const CONVERSATION_TURN_QUEUED = 'QUEUED';
const CONVERSATION_TURN_RUNNING = 'RUNNING';
const CONVERSATION_TURN_COMPLETED = 'COMPLETED';
const CONVERSATION_TURN_FAILED = 'FAILED';

function eventKey(sessionId: string, runtimeInstanceId: string, launchClaimNumber: number): string {
  return `${sessionId}:${runtimeInstanceId}:${launchClaimNumber}`;
}

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

function hasCompletePersistedSnapshot(session: Pick<SessionExecutionRecord, 'status' | 'logSnapshot'>): boolean {
  if (![SessionStatus.COMPLETED, SessionStatus.FAILED, SessionStatus.CANCELLED]
    .includes(session.status as SessionStatus) || !session.logSnapshot) {
    return false;
  }
  try {
    const snapshot = JSON.parse(session.logSnapshot) as Partial<NormalizedConversation>;
    return Array.isArray(snapshot.entries);
  } catch {
    return false;
  }
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

interface SendMessageOptions {
  /** User message was already appended while claiming a queued turn. */
  userEntryId?: string;
}

export class SessionManager {
  private snapshotFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private snapshotFlushChains = new Map<string, Promise<void>>();
  private sessionPersistenceWriterChain: Promise<void> = Promise.resolve();
  private dirtySnapshots = new Set<string>();
  private persistedSnapshotHashes = new Map<string, string>();
  private pendingSnapshotStatus = new Map<string, SessionStatus>();
  /** Terminal state gate: turn.completed and PTY exit may race each other. */
  private terminalSessions = new Map<string, SessionStatus>();
  private sessionFinalizations = new Map<string, Promise<void>>();
  /** Logical completion reserves this gate before broadcasting so a follow-up cannot overlap auto-commit. */
  private pendingAutoCommits = new Map<string, Promise<void>>();
  private pendingAutoCommitResolvers = new Map<string, () => void>();
  /**
   * A follow-up reserves the session before any async validation. Finalizers
   * wait on this reservation before reconciliation so a valid follow-up can
   * invalidate the old generation without racing Task/TeamRun post-processing.
   */
  private followUpReservations = new Map<string, Promise<void>>();
  private followUpReservationReleases = new Set<() => void>();
  /** Serializes user stop and direct follow-up actions for each Session. */
  private sessionActionReservations = new Map<string, Promise<void>>();
  private sessionActionReservationReleases = new Set<() => void>();
  /** Public initial starts are revocable before they enter RuntimeCoordinator admission. */
  private initialStartOperations = new Map<string, Set<AbortController>>();
  /** A synchronous stop intent rejects starts registered while stop is still in flight. */
  private sessionStopIntentCounts = new Map<string, number>();
  /** Incremented for every start/send cycle so late post-processing cannot affect a new turn. */
  private sessionGenerations = new Map<string, number>();
  // 每个 session 上次写入 TeamRun 心跳时间戳的时刻，用于节流 lastHeartbeatAt 落库。
  private heartbeatThrottle = new Map<string, number>();
  private readonly teamReconciler: TeamReconcilerService;
  private readonly runtimeCoordinator: RuntimeCoordinator;
  /** In-memory process owners are generation-scoped, never runtime-id global. */
  private readonly runtimeProcessIds = new Map<string, string>();
  /** Early exit/tree completion events can arrive before started-row persistence. */
  private readonly pendingRuntimeProcessEvents = new Map<string, Array<{
    event: RuntimeProcessEvent;
    expiresAt: number;
  }>>();
  private readonly pendingRuntimeEventExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runtimePermissionStates = new Map<string, boolean>();
  private readonly externalSessionPersistence = new Map<string, Promise<void>>();
  /** Durable conversation turns are consumed one at a time per Session. */
  private readonly conversationQueueWorkers = new Map<string, Promise<void>>();
  private conversationQueueStopping = false;
  private readonly artifactService = new AgentArtifactService();
  private static readonly SNAPSHOT_CHECKPOINT_MS = 15_000;
  private static readonly HEARTBEAT_THROTTLE_MS = 30_000;

  constructor(
    private readonly eventBus: EventBus,
    teamReconciler?: TeamReconcilerService,
    runtimeRegistry?: RuntimeRegistry,
  ) {
    this.teamReconciler = teamReconciler ?? new TeamReconcilerService({
      eventBus,
      sessionMessenger: this,
      // 续催/唤醒统一由 MemberHeartbeatScheduler 轮询驱动；这里关闭内部 setTimeout 避免双驱动重复触发。
      // session 退出时的首次 reconcile（COMPLETED 判定 / 首次补催）仍即时执行，不依赖该定时器。
      scheduleReminders: false,
    });
    this.runtimeCoordinator = new RuntimeCoordinator(
      runtimeRegistry ?? new StaticRuntimeRegistry([
        new CliRuntimeDriver(),
        new AcpRuntimeDriver(),
      ]),
      {
        onTurnEvent: (event) => this.handleRuntimeTurnEvent(event),
        onRuntimeState: (state) => this.handleRuntimeState(state),
        onProcessEvent: (event) => this.handleRuntimeProcessEvent(event),
        onDriverSessionDisposeStarted: (sessionId, runtimeInstanceId, launchClaimNumber) => {
          return this.markRuntimeProcessCleanupPending(sessionId, runtimeInstanceId, launchClaimNumber);
        },
        onDriverSessionDisposed: (sessionId) => {
          revokeAgentApiCredential(sessionId);
        },
        onDriverSessionDisposedInstance: async (sessionId, runtimeInstanceId, launchClaimNumber) => {
          await this.markRuntimeProcessCleanupState(
            sessionId,
            runtimeInstanceId,
            'CONFIRMED',
            undefined,
            launchClaimNumber,
          );
          const resolvedClaim = Number.isInteger(launchClaimNumber) && launchClaimNumber! > 0
            ? launchClaimNumber as number
            : null;
          const [process, launch] = resolvedClaim == null
            ? [null, null]
            : await Promise.all([
              prisma.executionProcess.findFirst({
                where: { sessionId, runtimeInstanceId, launchClaimNumber: resolvedClaim },
                select: { cleanupState: true },
              }),
              prisma.session.findUnique({
                where: { id: sessionId },
                select: {
                  runtimeLaunchState: true,
                  runtimeLaunchClaimCount: true,
                  runtimeLaunchResolvedCount: true,
                },
              }),
            ]);
          const processConfirmed = process?.cleanupState === 'CONFIRMED'
            && !this.hasRuntimeProcessOwner(runtimeInstanceId, sessionId, resolvedClaim);
          const safelyNeverStarted = process == null
            && launch?.runtimeLaunchState === RUNTIME_LAUNCH_STATES.SAFE_PRE_CHILD_FAILURE
            && launch.runtimeLaunchClaimCount === resolvedClaim
            && launch.runtimeLaunchResolvedCount === resolvedClaim;
          if (
            !processConfirmed
            && !safelyNeverStarted
          ) {
            throw new AgentRuntimeError(
              'runtime_cleanup_pending',
              'close',
              `Runtime process cleanup evidence for '${runtimeInstanceId}' is not durably confirmed`,
              true,
            );
          }
        },
        onDriverSessionDisposeFailed: (sessionId, runtimeInstanceId, error, launchClaimNumber) => {
          this.logSessionError('session.runtimeDispose', error, { sessionId, runtimeInstanceId });
          return this.markRuntimeProcessCleanupState(
            sessionId,
            runtimeInstanceId,
            'FAILED',
            error instanceof Error ? error.message : String(error),
            launchClaimNumber,
          );
        },
      },
    );

    // Patches only mark the snapshot dirty. A low-frequency checkpoint keeps the
    // hot stream away from SQLite while terminal paths still force a final flush.
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

    this.eventBus.on('session:turn-completed', ({ sessionId }) => {
      if (this.terminalSessions.has(sessionId)) return;
      // The parser has already written raw stdout, the final assistant entry,
      // usage and all other state from the turn.completed chunk at this point.
      this.terminalSessions.set(sessionId, SessionStatus.COMPLETED);
      this.startSessionFinalization(sessionId, 0, {
        logicalCompletion: true,
        runtimeInstanceId: this.runtimeCoordinator.getRuntimeInstanceId(sessionId),
      });
    });

    this.eventBus.on('session:turn-failed', ({ sessionId }) => {
      if (this.terminalSessions.has(sessionId)) return;
      // A turn failure is terminal even when the CLI wrapper later exits 0 or
      // without an exit code. Use a synthetic non-zero code for the shared
      // finalization path so success-only post-processing cannot run.
      this.terminalSessions.set(sessionId, SessionStatus.FAILED);
      this.startSessionFinalization(sessionId, 1, {
        logicalCompletion: true,
        runtimeInstanceId: this.runtimeCoordinator.getRuntimeInstanceId(sessionId),
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

  getRuntimeState(sessionId: string, runtimeType: RuntimeType = RuntimeType.CLI): RuntimeStateDto {
    return this.runtimeCoordinator.getState(sessionId, runtimeType);
  }

  /**
   * Persist a conversation message and schedule its runtime turn. The caller
   * only waits for the SQLite insert; ACP startup and prompt delivery happen
   * in the per-session queue worker.
   */
  async enqueueConversationMessage(
    sessionId: string,
    message: string,
    providerId?: string,
  ): Promise<{ turnId: string }> {
    const enqueueStartedAt = Date.now();
    const session = await this.findSessionExecutionRecord(sessionId);
    if (!session) {
      throw new NotFoundError('Session', sessionId);
    }
    this.ensureExecutionRecordIsLive(session);
    if (!this.isConversationSession(session)) {
      throw new ValidationError('Only conversation sessions support queued messages');
    }
    const effectiveProviderId = providerId ?? session.providerId;
    if (effectiveProviderId) {
      const provider = getProviderById(effectiveProviderId);
      if (!provider) {
        throw new ValidationError(`Provider not found: ${effectiveProviderId}`);
      }
      if (String(provider.agentType) !== session.agentType) {
        throw new ValidationError(
          `Cannot switch provider: agentType mismatch. Session uses '${session.agentType}', but provider '${provider.name}' is for '${provider.agentType}'`
        );
      }
      if (getProviderRuntimeType(provider) !== this.normalizeRuntimeType(session.runtimeType)) {
        throw new ValidationError(
          `Cannot switch provider: runtimeType mismatch. Session uses '${session.runtimeType}', but provider '${provider.name}' uses '${getProviderRuntimeType(provider)}'`
        );
      }
    }

    // Generate both identifiers before the insert. The entry id is persisted
    // with the queue row so a crash between applying the in-memory patch and
    // updating the row remains replayable without creating a duplicate entry.
    const turnId = randomUUID();
    const userEntryId = `user:${turnId}`;
    const turn = await prisma.conversationTurn.create({
      data: {
        id: turnId,
        sessionId,
        message,
        userEntryId,
        providerId: providerId ?? null,
        status: CONVERSATION_TURN_QUEUED,
      },
      select: { id: true },
    });
    // Reflect the user message immediately. This is local, synchronous work;
    // the expensive ACP startup/prompt remains exclusively in the worker. If
    // the in-memory snapshot cannot be updated, leave the durable turn queued
    // so the worker can retry the append instead of losing the message.
    try {
      this.appendUserMessageEntry(session, message, userEntryId);
    } catch (error) {
      this.logSessionError('conversation.queueUserEntry', error, {
        sessionId,
        turnId: turn.id,
      });
    }
    this.kickConversationQueue(sessionId);
    console.log(
      `[ConversationQueue] enqueued session=${sessionId} turn=${turn.id} persistMs=${Date.now() - enqueueStartedAt}`,
    );
    return { turnId: turn.id };
  }

  /** Recover turns left in RUNNING state by an interrupted server process. */
  async startConversationQueue(): Promise<void> {
    this.conversationQueueStopping = false;
    await prisma.conversationTurn.updateMany({
      where: { status: CONVERSATION_TURN_RUNNING },
      data: {
        status: CONVERSATION_TURN_QUEUED,
        startedAt: null,
      },
    });
    const pending = await prisma.conversationTurn.findMany({
      where: { status: CONVERSATION_TURN_QUEUED },
      select: { sessionId: true },
      distinct: ['sessionId'],
    });
    for (const turn of pending) {
      this.kickConversationQueue(turn.sessionId);
    }
  }

  /** Stop scheduling new work during the Fastify shutdown phase. */
  stopConversationQueue(): void {
    this.conversationQueueStopping = true;
  }

  /** Dispose a TeamRun-owned runtime after its invocation reaches a terminal state. */
  async disposeRuntimeSession(sessionId: string, expectedRuntimeInstanceId?: string): Promise<void> {
    await this.runtimeCoordinator.disposeSession(sessionId, expectedRuntimeInstanceId);
  }

  async retryRuntimeProcessCleanup(input: PersistedAcpProcessIdentity & {
    sessionId: string;
    runtimeInstanceId: string;
  }): Promise<void> {
    if (!Number.isInteger(input.launchClaimNumber) || input.launchClaimNumber! <= 0) {
      await this.quarantinePersistedRuntimeProcess(
        input.sessionId,
        input.runtimeInstanceId,
        'Runtime cleanup evidence is missing launchClaimNumber; automated signalling is disabled',
        null,
      );
      throw new AgentRuntimeError(
        'process_identity_mismatch',
        'close',
        'Runtime cleanup evidence is missing launchClaimNumber',
        true,
      );
    }
    try {
      if (this.runtimeCoordinator.hasRuntimeInstance(input.sessionId, input.runtimeInstanceId)) {
        const handled = await this.runtimeCoordinator.retryDisposedSessionCleanup(
          input.sessionId,
          input.runtimeInstanceId,
        );
        if (!handled && this.runtimeCoordinator.hasRuntimeInstance(input.sessionId, input.runtimeInstanceId)) {
          await this.runtimeCoordinator.disposeSession(input.sessionId, input.runtimeInstanceId);
        }
        return;
      }
      await cleanupPersistedAcpProcessTree(input);
      await this.markRuntimeProcessCleanupState(
        input.sessionId,
        input.runtimeInstanceId,
        'CONFIRMED',
        undefined,
        input.launchClaimNumber,
      );
    } catch (error) {
      await this.markRuntimeProcessCleanupState(
        input.sessionId,
        input.runtimeInstanceId,
        'FAILED',
        error instanceof Error ? error.message : String(error),
        input.launchClaimNumber,
      );
      throw error;
    }
  }

  hasRuntimeProcessOwner(
    runtimeInstanceId: string,
    sessionId?: string,
    launchClaimNumber?: number | null,
  ): boolean {
    if (sessionId && Number.isInteger(launchClaimNumber) && launchClaimNumber! > 0) {
      return this.runtimeProcessIds.has(eventKey(sessionId, runtimeInstanceId, launchClaimNumber!));
    }
    return [...this.runtimeProcessIds.keys()].some((key) => key.split(':')[1] === runtimeInstanceId);
  }

  private async quarantinePersistedRuntimeProcess(
    sessionId: string,
    runtimeInstanceId: string,
    diagnostic: string,
    launchClaimNumber?: number | null,
  ): Promise<void> {
    if (!Number.isInteger(launchClaimNumber) || launchClaimNumber! <= 0) {
      // Without a generation claim there is no safe process-row target. Keep
      // the session blocked, but never mutate another launch's owner row.
      await prisma.session.updateMany({
        where: { id: sessionId },
        data: {
          runtimeLaunchState: RUNTIME_LAUNCH_STATES.QUARANTINED,
          runtimeLaunchDiagnostic: diagnostic.slice(0, 2_000),
          runtimeLaunchDiagnosticCount: { increment: 1 },
          runtimeLaunchNextDiagnosticAt: new Date(Date.now() + 5 * 60_000),
        },
      }).catch((error) => {
        this.logSessionError('session.processCleanupQuarantine', error, { sessionId, runtimeInstanceId });
      });
      return;
    }
    await prisma.executionProcess.updateMany({
      where: {
        sessionId,
        runtimeInstanceId,
        launchClaimNumber,
        cleanupState: { not: 'CONFIRMED' },
      },
      data: {
        cleanupState: 'QUARANTINED',
        cleanupError: diagnostic.slice(0, 2_000),
        cleanupAttemptCount: { increment: 1 },
        nextCleanupRetryAt: new Date(Date.now() + 5 * 60_000),
      },
    }).catch((error) => {
      this.logSessionError('session.processCleanupQuarantine', error, { sessionId, runtimeInstanceId });
    });
  }

  private runtimeProcessKeyFor(sessionId: string, runtimeInstanceId: string): string | undefined {
    const prefix = sessionId + ':' + runtimeInstanceId + ':';
    return [...this.runtimeProcessIds.keys()].find((key) => key.startsWith(prefix));
  }

  private launchClaimFromRuntimeProcessKey(key: string | undefined): number | undefined {
    if (!key) return undefined;
    const claim = Number(key.slice(key.lastIndexOf(':') + 1));
    return Number.isInteger(claim) && claim > 0 ? claim : undefined;
  }

  async isRuntimeCleanupConfirmed(sessionId: string): Promise<boolean> {
    return (await evaluateSessionRuntimeCleanup(sessionId, {
      hasActiveTurn: (candidateId) => this.hasActiveTurn(candidateId),
      hasRuntimeProcessOwner: (runtimeInstanceId, ownerSessionId, launchClaimNumber) => this.hasRuntimeProcessOwner(
        runtimeInstanceId,
        ownerSessionId ?? sessionId,
        launchClaimNumber,
      ),
    })).confirmed;
  }

  async resolveRuntimePermission(sessionId: string, requestId: string, optionId: string): Promise<void> {
    await this.runtimeCoordinator.resolvePermission(sessionId, requestId, optionId);
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

    const provider = providerId ? getProviderById(providerId) : null;
    if (providerId && !provider) {
      throw new ValidationError(`Provider not found: ${providerId}`);
    }
    if (provider && provider.agentType !== agentType) {
      throw new ValidationError(
        `Provider '${provider.name}' belongs to agent '${provider.agentType}', not '${agentType}'`,
      );
    }
    const runtimeType = provider ? getProviderRuntimeType(provider) : RuntimeType.CLI;
    if (!supportsAgentRuntime(agentType, runtimeType)) {
      throw new ValidationError(`Agent '${agentType}' does not support the '${runtimeType}' runtime`);
    }

    return prisma.session.create({
      data: {
        workspaceId,
        context: SessionContext.WORKSPACE,
        agentType,
        runtimeType,
        variant,
        providerId: providerId ?? null,
        prompt,
        status: SessionStatus.PENDING,
      },
    });
  }

  async start(id: string) {
    console.log('[SessionManager] 🚀 Starting session:', id);

    const startOperation = this.reserveInitialStartOperation(id);
    try {
      const session = await startOperation.waitFor(() => this.findSessionExecutionRecord(id));
      startOperation.throwIfStopped();
      if (!session) {
        console.log('[SessionManager] ❌ Session not found:', id);
        return null;
      }
      await startOperation.waitFor(() => this.waitForPendingAutoCommit(id));
      startOperation.throwIfStopped();
      this.ensureExecutionRecordIsLive(session);
      const workingDir = this.getExecutionWorkingDir(session);

      console.log('[SessionManager] Session details:', {
        id: session.id,
        agentType: session.agentType,
        variant: session.variant,
        prompt: summarizeTextForLog(session.prompt),
        workingDir,
      });

      // No await separates this final operation check from Coordinator lease
      // publication inside startRuntimeTurn(). A later stop is then observed by
      // the runtime admission signal instead of being lost between the gates.
      startOperation.throwIfStopped();
      await this.startRuntimeTurn(
        session,
        session.prompt,
        session.externalSessionId,
        session.providerId,
        'load',
        undefined,
        true,
      );
      return session;
    } finally {
      startOperation.release();
    }
  }

  async startFollowUp(id: string, resumeFromSessionId: string) {
    console.log('[SessionManager] 🚀 Starting follow-up session:', id);
    console.log('[SessionManager] Resume from Tower session:', resumeFromSessionId);

    const startOperation = this.reserveInitialStartOperation(id);
    try {
      const session = await startOperation.waitFor(() => this.findSessionExecutionRecord(id));
      startOperation.throwIfStopped();
      if (!session) {
        console.log('[SessionManager] ❌ Session not found:', id);
        return null;
      }
      await startOperation.waitFor(() => this.waitForPendingAutoCommit(id));
      startOperation.throwIfStopped();
      this.ensureExecutionRecordIsLive(session);

      const resumeFromSession = await startOperation.waitFor(() => prisma.session.findUnique({
        where: { id: resumeFromSessionId },
        select: { logSnapshot: true, externalSessionId: true },
      }));
      startOperation.throwIfStopped();
      const agentSessionId = resumeFromSession
        ? resumeFromSession.externalSessionId
          ?? this.resolveAgentSessionId(resumeFromSessionId, resumeFromSession.logSnapshot)
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

      startOperation.throwIfStopped();
      await this.startRuntimeTurn(
        session,
        session.prompt,
        agentSessionId,
        session.providerId,
        'resume',
        undefined,
        true,
      );
      return session;
    } finally {
      startOperation.release();
    }
  }

  async sendMessage(
    id: string,
    message: string,
    providerId?: string,
    expectedTeamRunInvocationId?: string,
    options: SendMessageOptions = {},
  ) {
    console.log('[SessionManager] 📨 Sending message to session:', id);
    console.log('[SessionManager] Message summary:', summarizeTextForLog(message));
    if (providerId) {
      console.log('[SessionManager] Switching provider to:', providerId);
    }

    const reservation = this.reserveFollowUp(id);
    let actionReservation: ReturnType<SessionManager['reserveSessionAction']> | undefined;
    let releaseTeamRunAdmission: (() => void) | undefined;
    try {
      // Serialize concurrent follow-ups for the same session while retaining
      // the reservation in the map so the old finalizer cannot reconcile.
      await reservation.previous;

      // TeamRun follow-ups are admission-controlled just like initial starts.
      // A REST/MCP caller must carry the current invocation identity; browser
      // or stale/terminal callers must never be able to resurrect a member.
      const teamRunInvocation = await prisma.agentInvocation.findFirst({
        where: { sessionId: id },
        select: { id: true, teamRunId: true, memberId: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (teamRunInvocation) {
        if (expectedTeamRunInvocationId !== teamRunInvocation.id) {
          throw new ServiceError(
            'TeamRun follow-up requires the current invocation identity',
            'SESSION_NOT_ADMITTED',
            409,
          );
        }
        releaseTeamRunAdmission = await acquireTeamMemberAdmission(
          teamRunInvocation.teamRunId,
          teamRunInvocation.memberId,
        );
        await this.assertTeamRunDispatchAdmitted(id, expectedTeamRunInvocationId);
      } else if (expectedTeamRunInvocationId) {
        await this.assertTeamRunDispatchAdmitted(id, expectedTeamRunInvocationId);
      }

      // TeamRun stop owns member admission before entering SessionManager.
      // Preserve that lock order, then serialize the runtime mutation itself.
      actionReservation = this.reserveSessionAction(id);
      await actionReservation.previous;

      const session = await this.findSessionExecutionRecord(id);
      if (!session) {
        console.log('[SessionManager] ❌ Session not found:', id);
        return null;
      }
      this.ensureExecutionRecordIsLive(session);

      // A failed explicit stop leaves the DISPOSED DriverSession attached so
      // its process owner can be retried. Confirm that cleanup before clearing
      // the terminal gate, advancing the generation, issuing a credential, or
      // claiming another launch; otherwise a never-opened turn is quarantined.
      await this.runtimeCoordinator.retryDisposedSessionCleanup(id);

      const resumeMode: RuntimeResumeMode = this.normalizeRuntimeType(session.runtimeType) === RuntimeType.ACP
        && hasCompletePersistedSnapshot(session)
        ? 'resume'
        : 'load';

      // Always validate the effective provider, including when it is inherited
      // from the session or explicitly repeats the current provider. A stale
      // session provider must not invalidate the completed generation.
      const effectiveProviderId = providerId ?? session.providerId;
      if (effectiveProviderId) {
        const effectiveProvider = getProviderById(effectiveProviderId);
        if (!effectiveProvider) {
          throw new Error(`Provider not found: ${effectiveProviderId}`);
        }
        if (String(effectiveProvider.agentType) !== session.agentType) {
          throw new Error(
            `Cannot switch provider: agentType mismatch. Session uses '${session.agentType}', but provider '${effectiveProvider.name}' is for '${effectiveProvider.agentType}'`
          );
        }
        if (getProviderRuntimeType(effectiveProvider) !== this.normalizeRuntimeType(session.runtimeType)) {
          throw new Error(
            `Cannot switch provider: runtimeType mismatch. Session uses '${session.runtimeType}', but provider '${effectiveProvider.name}' uses '${getProviderRuntimeType(effectiveProvider)}'`
          );
        }
      }

      if (providerId && providerId !== session.providerId) {
        const switchedProvider = getProviderById(providerId);
        await prisma.session.update({
          where: { id },
          data: { providerId },
        });
        console.log(`[SessionManager] ✅ Provider switched to: ${switchedProvider?.name ?? providerId}`);
      }

      // Stop the previous turn before waiting for its auto-commit boundary. The
      // coordinator suppresses that superseded turn's terminal event so it cannot
      // finalize the newly reserved generation.
      if (this.runtimeCoordinator.hasActiveTurn(id)) {
        if (DEBUG_SNAPSHOT) {
          console.log(`[SessionManager:snapshot] sendMessage checkpoint before runtime turn replace sessionId=${id}`);
        }
        await this.flushSnapshotPersist(id);
        const canReuseDriverSession = await this.runtimeCoordinator.abandonTurn(id);
        if (!canReuseDriverSession) {
          await this.runtimeCoordinator.disposeSession(id);
        }
      }
      await this.waitForPendingAutoCommit(id);

      const userEntryId = options.userEntryId ?? this.appendUserMessageEntry(session, message);

      const agentSessionId = session.externalSessionId
        ?? this.resolveAgentSessionId(id, session.logSnapshot);
      if (providerId && providerId !== session.providerId) {
        await this.runtimeCoordinator.disposeSession(id);
      }
      await this.startRuntimeTurn(
        session,
        message,
        agentSessionId,
        effectiveProviderId,
        resumeMode,
        userEntryId,
        false,
        expectedTeamRunInvocationId,
        true,
      );
      return session;
    } finally {
      releaseTeamRunAdmission?.();
      reservation.release();
      actionReservation?.release();
    }
  }

  async stop(id: string, options: StopSessionOptions = {}) {
    // Publish stop intent synchronously, before the session-action queue can
    // yield. Initial starts still doing DB/auto-commit preparation are revoked
    // without making stop wait for those unrelated operations.
    const releaseStopIntent = this.beginSessionStopIntent(id);
    const actionReservation = this.reserveSessionAction(id);
    let pendingFinalization: Promise<void> | undefined;
    let stoppedSession: PrismaSession | null = null;
    try {
      try {
        await actionReservation.previous;
        const result = await this.stopWithinSessionAction(id, options);
        stoppedSession = result.session;
        pendingFinalization = result.pendingFinalization;
      } finally {
        // A follow-up queued after stop may already be blocking the old terminal
        // finalizer. Release the action boundary before waiting for that finalizer.
        actionReservation.release();
      }
      await pendingFinalization;
      return stoppedSession;
    } finally {
      releaseStopIntent();
    }
  }

  private async stopWithinSessionAction(id: string, options: StopSessionOptions) {
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) return { session: null };

    const hasActiveTurn = this.runtimeCoordinator.hasActiveTurn(id);
    const runtimeDisposal = this.normalizeRuntimeType(session.runtimeType) === RuntimeType.ACP && hasActiveTurn
      ? this.runtimeCoordinator.cancelAndDisposeSession(id)
      : this.runtimeCoordinator.disposeSession(id);
    // TeamRun reconciliation and snapshot persistence may run before cleanup is
    // awaited. Observe an early rejection while retaining it for the boundary below.
    void runtimeDisposal.catch(() => undefined);
    if (hasActiveTurn && this.normalizeRuntimeType(session.runtimeType) !== RuntimeType.ACP) {
      void this.runtimeCoordinator.cancelTurn(id).catch((error) => {
        this.logSessionError('session.runtimeCancel', error, { sessionId: id });
      });
    }

    // The disposal request above has cancelled any startup lease that can mint
    // a DriverSession-bound credential. Revoke it before fallible persistence
    // while the runtime owner remains available for a later cleanup retry.
    revokeAgentApiCredential(id);

    // Revoke TeamRun dispatch before waiting for runtime cleanup. A direct
    // Session stop does not pass through TeamSchedulerService, so delaying this
    // until cleanup succeeds would leave heartbeat/follow-up admission open.
    if (!options.skipTeamRunReconcile && !this.isConversationSession(session)) {
      await this.teamReconciler.handleSessionStopped(id);
    }

    const terminalStatus = this.terminalSessions.get(id);
    const persistedTerminal = [
      SessionStatus.COMPLETED,
      SessionStatus.FAILED,
      SessionStatus.CANCELLED,
    ].includes(session.status as SessionStatus);
    if (!hasActiveTurn && (terminalStatus || persistedTerminal)) {
      const pendingFinalization = this.sessionFinalizations.get(id);
      // A terminal transition already won the race. A late user stop may
      // clean up the PTY, but it must not regress the persisted status. The
      // backing TeamRun invocation may still be waiting for a room reply, so
      // it must still pass through the cancellation reconciler.
      await runtimeDisposal;
      if (!await this.isRuntimeCleanupConfirmed(id)) {
        this.terminalSessions.delete(id);
        return { session };
      }
      this.maybeClearTerminalState(id);
      if (terminalStatus && !persistedTerminal) {
        await prisma.session.updateMany({
          where: { id, status: { notIn: [SessionStatus.COMPLETED, SessionStatus.FAILED, SessionStatus.CANCELLED] } },
          data: { status: terminalStatus },
        });
      }
      return {
        session,
        pendingFinalization: options.skipTeamRunReconcile ? undefined : pendingFinalization,
      };
    }
    this.terminalSessions.set(id, SessionStatus.CANCELLED);

    await runtimeDisposal;
    // Explicit stop revokes the DriverSession-bound workspace-service credential.
    // A later follow-up reopens from the persisted external session id with a new credential.
    // Do not report a stopped TeamRun member until the owned process tree has
    // confirmed cleanup. The scheduler will retain the invocation and block
    // the next admission when this rejects, allowing a later retry/recovery.
    if (!await this.isRuntimeCleanupConfirmed(id)) {
      this.terminalSessions.delete(id);
      return { session };
    }

    await this.externalSessionPersistence.get(id);
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

    this.eventBus.emit('session:stopped', { sessionId: id });
    // Cancellation does not run normal terminal finalization, so release the
    // store after the CANCELLED snapshot has been persisted above.
    sessionMsgStoreManager.delete(id);
    this.releaseSnapshotPersistenceState(id);
    return { session };
  }

  /** @deprecated Use hasActiveTurn(). */
  hasActivePipeline(sessionId: string): boolean {
    return this.runtimeCoordinator.hasActiveTurn(sessionId);
  }

  hasActiveTurn(sessionId: string): boolean {
    return this.runtimeCoordinator.hasActiveTurn(sessionId);
  }

  isAwaitingPermission(sessionId: string): boolean {
    return this.runtimeCoordinator.isAwaitingPermission(sessionId);
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
    this.runtimeCoordinator.writeInput(sessionId, data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.runtimeCoordinator.resize(sessionId, cols, rows);
  }

  /** Close all runtime driver sessions during graceful server shutdown. */
  async destroyAll(): Promise<void> {
    this.stopConversationQueue();
    await this.runtimeCoordinator.destroyAll();
    this.pendingRuntimeProcessEvents.clear();
    for (const timer of this.pendingRuntimeEventExpiryTimers.values()) clearTimeout(timer);
    this.pendingRuntimeEventExpiryTimers.clear();
    await Promise.allSettled(this.externalSessionPersistence.values());
    this.externalSessionPersistence.clear();
    this.terminalSessions.clear();
    for (const resolve of this.pendingAutoCommitResolvers.values()) resolve();
    this.pendingAutoCommitResolvers.clear();
    this.pendingAutoCommits.clear();
    for (const release of [...this.followUpReservationReleases]) release();
    this.followUpReservationReleases.clear();
    this.followUpReservations.clear();
    for (const release of [...this.sessionActionReservationReleases]) release();
    this.sessionActionReservationReleases.clear();
    this.sessionActionReservations.clear();
    for (const operations of this.initialStartOperations.values()) {
      for (const controller of operations) {
        controller.abort(this.sessionStartStoppedError());
      }
    }
    this.initialStartOperations.clear();
    this.sessionStopIntentCounts.clear();
    clearAgentApiCredentials();
  }

  private kickConversationQueue(sessionId: string): void {
    if (this.conversationQueueStopping || this.conversationQueueWorkers.has(sessionId)) {
      return;
    }

    const worker = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        this.processConversationQueue(sessionId).then(resolve, reject);
      });
    });
    this.conversationQueueWorkers.set(sessionId, worker);
    void worker
      .catch((error) => {
        this.logSessionError('conversation.queue', error, { sessionId });
      })
      .finally(() => {
        if (this.conversationQueueWorkers.get(sessionId) === worker) {
          this.conversationQueueWorkers.delete(sessionId);
        }
        // Cover an enqueue racing with the worker's final empty scan without
        // creating a worker spin loop when the queue is actually empty.
        if (!this.conversationQueueStopping) {
          void prisma.conversationTurn.count({
            where: { sessionId, status: CONVERSATION_TURN_QUEUED },
          }).then((count) => {
            if (count > 0) this.kickConversationQueue(sessionId);
          }).catch((error) => {
            this.logSessionError('conversation.queueScan', error, { sessionId });
          });
        }
      });
  }

  private async processConversationQueue(sessionId: string): Promise<void> {
    while (!this.conversationQueueStopping) {
      const queued = await prisma.conversationTurn.findFirst({
        where: { sessionId, status: CONVERSATION_TURN_QUEUED },
        orderBy: [{ queuedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      if (!queued) return;

      const claimed = await prisma.conversationTurn.updateMany({
        where: { id: queued.id, status: CONVERSATION_TURN_QUEUED },
        data: {
          status: CONVERSATION_TURN_RUNNING,
          attempts: { increment: 1 },
          startedAt: new Date(),
          lastError: null,
        },
      });
      if (claimed.count !== 1) continue;

      try {
        console.log(
          `[ConversationQueue] claimed session=${sessionId} turn=${queued.id} queueWaitMs=${Math.max(0, Date.now() - queued.queuedAt.getTime())} attempt=${queued.attempts + 1}`,
        );
        // A conversation accepts one ACP prompt at a time. Waiting here keeps
        // queued follow-ups from cancelling the previous turn (and hitting
        // RuntimeCoordinator's ten-second abandon timeout).
        const previousTurnWaitStartedAt = Date.now();
        await this.runtimeCoordinator.waitForTurnCompletion(sessionId);
        console.log(
          `[ConversationQueue] priorTurnReady session=${sessionId} turn=${queued.id} waitMs=${Date.now() - previousTurnWaitStartedAt}`,
        );
        if (this.conversationQueueStopping) {
          await this.requeueConversationTurn(queued.id);
          return;
        }

        const session = await this.findSessionExecutionRecord(sessionId);
        if (!session) throw new NotFoundError('Session', sessionId);
        this.ensureExecutionRecordIsLive(session);
        const userEntryId = queued.userEntryId ?? `user:${queued.id}`;
        this.appendUserMessageEntry(session, queued.message, userEntryId);
        if (!queued.userEntryId) {
          await prisma.conversationTurn.updateMany({
            where: { id: queued.id, status: CONVERSATION_TURN_RUNNING },
            data: { userEntryId },
          });
        }
        const dispatchStartedAt = Date.now();
        await this.sendMessage(
          sessionId,
          queued.message,
          queued.providerId ?? undefined,
          undefined,
          { userEntryId },
        );
        console.log(
          `[ConversationQueue] dispatched session=${sessionId} turn=${queued.id} dispatchMs=${Date.now() - dispatchStartedAt}`,
        );
        const turnWaitStartedAt = Date.now();
        await this.runtimeCoordinator.waitForTurnCompletion(sessionId);
        await prisma.conversationTurn.updateMany({
          where: { id: queued.id, status: CONVERSATION_TURN_RUNNING },
          data: {
            status: CONVERSATION_TURN_COMPLETED,
            completedAt: new Date(),
          },
        });
        console.log(
          `[ConversationQueue] completed session=${sessionId} turn=${queued.id} runtimeWaitMs=${Date.now() - turnWaitStartedAt}`,
        );
      } catch (error) {
        if (this.conversationQueueStopping) {
          await this.requeueConversationTurn(queued.id);
          return;
        }
        const lastError = error instanceof Error ? error.message : String(error);
        await prisma.conversationTurn.updateMany({
          where: { id: queued.id, status: CONVERSATION_TURN_RUNNING },
          data: {
            status: CONVERSATION_TURN_FAILED,
            lastError: lastError.slice(0, 2_000),
            completedAt: new Date(),
          },
        });
        const errorSummary = summarizeTextForLog(lastError);
        console.log(
          `[ConversationQueue] failed session=${sessionId} turn=${queued.id} errorLength=${errorSummary.length} errorSha256=${errorSummary.sha256}`,
        );
        this.logSessionError('conversation.queueTurn', error, {
          sessionId,
          turnId: queued.id,
        });
      }
    }
  }

  private async requeueConversationTurn(turnId: string): Promise<void> {
    await prisma.conversationTurn.updateMany({
      where: { id: turnId, status: CONVERSATION_TURN_RUNNING },
      data: {
        status: CONVERSATION_TURN_QUEUED,
        startedAt: null,
      },
    });
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

  private async startRuntimeTurn(
    session: SessionExecutionRecord,
    prompt: string,
    resumeExternalSessionId?: string | null,
    providerId: string | null = session.providerId,
    resumeMode: RuntimeResumeMode = 'load',
    historyBoundaryEntryId?: string,
    initialStart = false,
    expectedTeamRunInvocationId?: string,
    advanceGeneration = false,
  ): Promise<void> {
    const workingDir = this.getExecutionWorkingDir(session);
    let launchClaimNumber: number | null = null;
    let admissionEntered = false;
    let reportedError: unknown;
    try {
      let handle: Awaited<ReturnType<RuntimeCoordinator['startTurn']>> | undefined;
      await this.runtimeCoordinator.withStartAdmission(session.id, async (admission) => {
        admissionEntered = true;
        try {
          this.assertPreChildAdmission(admission);
          // A rejected follow-up must not supersede the completed generation
          // until it owns the same disposal boundary as credential/claim setup.
          if (advanceGeneration) this.invalidateSessionGeneration(session.id);
          this.beginSessionExecution(session.id);

          const env = ExecutionEnv.default(workingDir);
          if (providerId) {
            const provider = getProviderById(providerId);
            if (provider && Object.keys(provider.env).length > 0) {
              env.merge(filterAgentSubprocessExternalEnv(provider.env));
            }
          }
          if (!this.isConversationSession(session)) {
            await this.injectTeamRunInvocationEnv(session.id, env);
            this.assertPreChildAdmission(admission);
          }
          this.injectAgentTowerMcpServiceEnv(session.id, env);
          this.assertPreChildAdmission(admission);

          const isNewStore = !sessionMsgStoreManager.has(session.id);
          const msgStore = sessionMsgStoreManager.getOrCreate(session.id);
          if (isNewStore && session.logSnapshot) {
            try {
              msgStore.restoreFromSnapshot(JSON.parse(session.logSnapshot) as NormalizedConversation);
            } catch (error) {
              this.logSessionError('session.snapshotRestore', error, { sessionId: session.id });
            }
          }

          // Every turn claim is durable before RuntimeCoordinator can call a driver.
          // The lease remains held until runTurn has either failed before spawn or
          // handed the child/transport to its DriverSession owner.
          launchClaimNumber = await this.claimRuntimeLaunch(session.id, initialStart);
          this.assertPreChildAdmission(admission);
          try {
            await this.assertTeamRunDispatchAdmitted(session.id, expectedTeamRunInvocationId);
          } catch (error) {
            throw markPreChildProcessFailure(error);
          }
          this.assertPreChildAdmission(admission);
          const runtimePrompt = buildWorkspaceRuntimePrompt(session, prompt);
          handle = await this.runtimeCoordinator.startTurn({
            towerSessionId: session.id,
            agentType: session.agentType as AgentType,
            runtimeType: this.normalizeRuntimeType(session.runtimeType),
            variant: session.variant ?? 'DEFAULT',
            providerId,
            workingDir,
            env,
            externalSessionId: session.externalSessionId,
            msgStore,
            prompt: session.purpose === SessionPurpose.CHAT
              ? appendAgentOutputIntentInstructions(runtimePrompt)
              : runtimePrompt,
            resumeExternalSessionId,
            resumeMode,
            historyBoundaryEntryId,
            launchClaimNumber,
            admission,
          });
          await this.resolveReusedRuntimeLaunch(session.id, launchClaimNumber);
          this.eventBus.emit('session:started', { sessionId: session.id });
        } catch (error) {
          const preChildFailure = launchClaimNumber != null && (
            isPreChildProcessFailure(error)
            || (error instanceof AgentRuntimeError && error.code === 'runtime_admission_cancelled')
          );
          let launchResolutionError: unknown;
          if (preChildFailure) {
            try {
              // Finish the durable no-child proof before disposal may close or
              // delete the managed session attached to this lease.
              await this.resolvePreChildRuntimeLaunchFailure(session.id, launchClaimNumber!, error);
            } catch (persistError) {
              launchResolutionError = persistError;
            }
          }
          revokeAgentApiCredential(session.id);
          if (launchClaimNumber != null) {
            if (!preChildFailure) {
              await this.quarantineRuntimeLaunch(session.id, launchClaimNumber, error);
            } else if (launchResolutionError) {
              await this.quarantineRuntimeLaunch(session.id, launchClaimNumber, launchResolutionError);
            }
          }
          reportedError = launchResolutionError ?? error;
          throw reportedError;
        }
      });
      // Terminal persistence is driven by Runtime turn events. Attach a catch
      // so the public start/message methods do not leave a rejected handle
      // unobserved after they have returned to the HTTP caller.
      void handle!.completion.catch(() => undefined);
      await this.checkTaskAutoRevert(session.id);
    } catch (error) {
      // Admission may fail while waiting for an older disposal. Do not turn
      // that retryable gate failure into a fresh disposal attempt.
      const finalError = reportedError ?? error;
      if (!admissionEntered) {
        this.logSessionError('session.runtimeAdmission', finalError, {
          sessionId: session.id,
          agentType: session.agentType,
          runtimeType: session.runtimeType,
          providerId,
          workingDir,
        });
        throw normalizeExecutorStartError(finalError);
      }
      await this.runtimeCoordinator.disposeSession(session.id).catch(() => undefined);
      revokeAgentApiCredential(session.id);
      const cleanupConfirmed = await this.isRuntimeCleanupConfirmed(session.id).catch(() => false);
      if (cleanupConfirmed) {
        await prisma.session.update({
          where: { id: session.id },
          data: { status: SessionStatus.CANCELLED },
        }).catch(() => undefined);
      }
      sessionMsgStoreManager.delete(session.id);
      this.releaseSnapshotPersistenceState(session.id);
      this.logSessionError('session.runtimeStart', finalError, {
        sessionId: session.id,
        agentType: session.agentType,
        runtimeType: session.runtimeType,
        providerId,
        workingDir,
      });
      throw normalizeExecutorStartError(finalError);
    }
  }

  private assertPreChildAdmission(admission: RuntimeStartAdmission): void {
    try {
      admission.throwIfCancelled();
    } catch (error) {
      throw markPreChildProcessFailure(error);
    }
  }

  private async claimRuntimeLaunch(sessionId: string, initialStart: boolean): Promise<number> {
    return prisma.$transaction(async (tx) => {
      const current = await tx.session.findUnique({
        where: { id: sessionId },
        select: { status: true, runtimeLaunchClaimCount: true, runtimeLaunchResolvedCount: true },
      });
      const admittedStatuses = initialStart
        ? [SessionStatus.PENDING]
        : [
          SessionStatus.PENDING,
          SessionStatus.RUNNING,
          SessionStatus.COMPLETED,
          SessionStatus.FAILED,
          SessionStatus.CANCELLED,
        ];
      if (
        !current
        || !admittedStatuses.includes(current.status as SessionStatus)
        || current.runtimeLaunchClaimCount !== current.runtimeLaunchResolvedCount
      ) {
        throw new ServiceError(
          initialStart
            ? 'Session start was revoked before process ownership was acquired'
            : 'Session follow-up was revoked before process ownership was acquired',
          'SESSION_NOT_ADMITTED',
          409,
        );
      }
      const claimNumber = current.runtimeLaunchClaimCount + 1;
      const admitted = await tx.session.updateMany({
        where: {
          id: sessionId,
          status: current.status,
          runtimeLaunchClaimCount: current.runtimeLaunchClaimCount,
          runtimeLaunchResolvedCount: current.runtimeLaunchResolvedCount,
        },
        data: {
          status: SessionStatus.RUNNING,
          runtimeLaunchState: RUNTIME_LAUNCH_STATES.CLAIMED,
          runtimeLaunchClaimCount: { increment: 1 },
          runtimeLaunchDiagnostic: null,
          runtimeLaunchNextDiagnosticAt: null,
        },
      });
      if (admitted.count !== 1) {
        throw new ServiceError('Session runtime launch admission changed concurrently', 'SESSION_NOT_ADMITTED', 409);
      }
      return claimNumber;
    });
  }

  private async resolveReusedRuntimeLaunch(sessionId: string, claimNumber: number): Promise<void> {
    await prisma.session.updateMany({
      where: {
        id: sessionId,
        runtimeLaunchClaimCount: claimNumber,
        runtimeLaunchResolvedCount: claimNumber - 1,
        runtimeLaunchState: RUNTIME_LAUNCH_STATES.CLAIMED,
      },
      data: {
        runtimeLaunchState: RUNTIME_LAUNCH_STATES.REUSED,
        runtimeLaunchResolvedCount: { increment: 1 },
        runtimeLaunchDiagnostic: null,
        runtimeLaunchNextDiagnosticAt: null,
      },
    });
  }

  private async resolvePreChildRuntimeLaunchFailure(
    sessionId: string,
    claimNumber: number,
    error: unknown,
  ): Promise<void> {
    await prisma.session.updateMany({
      where: {
        id: sessionId,
        runtimeLaunchClaimCount: claimNumber,
        runtimeLaunchResolvedCount: claimNumber - 1,
        runtimeLaunchState: RUNTIME_LAUNCH_STATES.CLAIMED,
      },
      data: {
        runtimeLaunchState: RUNTIME_LAUNCH_STATES.SAFE_PRE_CHILD_FAILURE,
        runtimeLaunchResolvedCount: { increment: 1 },
        runtimeLaunchDiagnostic: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        runtimeLaunchNextDiagnosticAt: null,
      },
    });
  }

  private async quarantineRuntimeLaunch(
    sessionId: string,
    claimNumber: number,
    error: unknown,
  ): Promise<void> {
    const diagnostic = `Runtime launch claim ${claimNumber} failed without proof that no child was created: ${error instanceof Error ? error.message : String(error)}`;
    await prisma.session.updateMany({
      where: {
        id: sessionId,
        runtimeLaunchClaimCount: claimNumber,
        runtimeLaunchResolvedCount: { lt: claimNumber },
      },
      data: {
        runtimeLaunchState: RUNTIME_LAUNCH_STATES.QUARANTINED,
        runtimeLaunchDiagnostic: diagnostic.slice(0, 2_000),
        runtimeLaunchDiagnosticCount: { increment: 1 },
        runtimeLaunchNextDiagnosticAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    console.warn(`[SessionManager] Session ${sessionId} runtime launch quarantined: ${diagnostic}`);
  }

  private async assertTeamRunDispatchAdmitted(
    sessionId: string,
    expectedInvocationId?: string,
  ): Promise<void> {
    const invocation = await prisma.agentInvocation.findFirst({
      where: {
        sessionId,
        ...(expectedInvocationId ? { id: expectedInvocationId } : {}),
      },
      select: { id: true, teamRunId: true, memberId: true, status: true, dispatchRevokedAt: true },
    });
    const member = invocation
      ? await prisma.teamMember.findUnique({
        where: { id: invocation.memberId },
        select: { teamRunId: true, membershipStatus: true },
      })
      : null;
    if (
      invocation?.dispatchRevokedAt
      || (expectedInvocationId && (
        !invocation
        || !['QUEUED', 'RUNNING', 'SESSION_ENDED', 'WAITING_ROOM_REPLY'].includes(invocation.status)
      ))
      || (invocation && (
        !member
        || member.teamRunId !== invocation.teamRunId
        || member.membershipStatus !== 'ACTIVE'
        || !['QUEUED', 'RUNNING', 'SESSION_ENDED', 'WAITING_ROOM_REPLY'].includes(invocation.status)
      ))
    ) {
      throw new ServiceError(
        'TeamRun dispatch was revoked before process ownership was acquired',
        'SESSION_NOT_ADMITTED',
        409,
      );
    }
  }

  private handleRuntimeTurnEvent(envelope: RuntimeTurnEventEnvelope): void {
    const sessionId = envelope.towerSessionId;
    const event = envelope.event;
    if (event.type === 'stdout') {
      this.eventBus.emit('session:stdout', { sessionId, data: event.data });
      return;
    }
    if (event.type === 'conversation_patch') {
      this.eventBus.emit('session:patch', { sessionId, patch: event.patch, seq: event.seq });
      return;
    }
    if (event.type === 'external_session_id') {
      const previous = this.externalSessionPersistence.get(sessionId) ?? Promise.resolve();
      const persistence = previous
        .then(() => this.enqueueSessionPersistenceWrite(async () => {
          await prisma.session.update({
            where: { id: sessionId },
            data: { externalSessionId: event.externalSessionId },
          });
        }))
        .then(() => undefined)
        .catch((error) => {
          this.logSessionError('session.externalSessionId', error, { sessionId });
        });
      this.externalSessionPersistence.set(sessionId, persistence);
      void persistence.finally(() => {
        if (this.externalSessionPersistence.get(sessionId) === persistence) {
          this.externalSessionPersistence.delete(sessionId);
        }
      });
      this.eventBus.emit('session:sessionId', {
        sessionId,
        agentSessionId: event.externalSessionId,
      });
      return;
    }
    if (event.type === 'permission_requested') {
      this.eventBus.emit('session:permission_requested', {
        sessionId,
        permission: event.request,
      });
      return;
    }
    if (event.type === 'permission_invalidated') {
      this.eventBus.emit('session:permission_invalidated', {
        sessionId,
        turnId: envelope.turnId,
        requestId: event.requestId,
      });
      return;
    }
    if (event.type === 'completed') {
      this.eventBus.emit('session:turn-completed', { sessionId });
      this.eventBus.emit('session:exit', { sessionId, exitCode: 0 });
      return;
    }
    if (event.type === 'failed') {
      this.eventBus.emit('session:turn-failed', { sessionId });
      this.eventBus.emit('session:exit', { sessionId, exitCode: 1 });
    }
  }

  private handleRuntimeState(state: RuntimeStateDto): void {
    setRuntimeStateSnapshot(state);
    this.eventBus.emit('session:runtime_state_changed', {
      sessionId: state.sessionId,
      state,
    });
    const awaitingPermission = state.turnState === 'AWAITING_PERMISSION';
    const previous = this.runtimePermissionStates.get(state.sessionId) ?? false;
    if (state.turnState === 'DISPOSED') {
      this.runtimePermissionStates.delete(state.sessionId);
    } else {
      this.runtimePermissionStates.set(state.sessionId, awaitingPermission);
    }
    if (previous !== awaitingPermission) {
      void this.invalidateTeamRunRuntimeState(state.sessionId);
    }
  }

  private async invalidateTeamRunRuntimeState(sessionId: string): Promise<void> {
    const invocation = await prisma.agentInvocation.findFirst({
      where: { sessionId },
      select: {
        teamRunId: true,
        teamRun: { select: { taskId: true, task: { select: { projectId: true } } } },
      },
    });
    if (!invocation) return;
    this.eventBus.emit('team-run:invalidated', {
      teamRunId: invocation.teamRunId,
      taskId: invocation.teamRun.taskId,
      projectId: invocation.teamRun.task.projectId,
      scopes: ['team-members', 'agent-invocations', 'team-run'],
      reason: 'agent-invocation-updated',
    });
  }

  private async handleRuntimeProcessEvent(event: RuntimeProcessEvent): Promise<void> {
    this.prunePendingRuntimeProcessEvents();
    const launchClaimNumber = Number.isInteger(event.launchClaimNumber) && event.launchClaimNumber! > 0
      ? event.launchClaimNumber!
      : null;
    if (event.type === 'started') {
      let processRecord: { id: string; cleanupState: string };
      try {
        processRecord = await prisma.$transaction(async (tx) => {
        const session = await tx.session.findUnique({
          where: { id: event.towerSessionId },
          include: { workspace: { include: { task: true } }, conversation: true },
        });
        if (!session) throw new NotFoundError('Session', event.towerSessionId);
        this.ensureExecutionRecordIsLive(session);
        const launchClaimNumber = Number.isInteger(event.launchClaimNumber)
          && event.launchClaimNumber > 0
          ? event.launchClaimNumber
          : null;
        const runtimeInstanceId = typeof event.runtimeInstanceId === 'string'
          && event.runtimeInstanceId.length > 0
          ? event.runtimeInstanceId
          : null;
        const processGroupId = typeof event.processGroupId === 'string'
          && event.processGroupId.length > 0
          ? event.processGroupId
          : null;
        const birthMarker = typeof event.birthMarker === 'string'
          && event.birthMarker.length > 0
          ? event.birthMarker
          : null;
        const ownershipToken = typeof event.ownershipToken === 'string'
          && event.ownershipToken.length > 0
          ? event.ownershipToken
          : null;
        const identityComplete = runtimeInstanceId != null
          && Number.isInteger(event.pid)
          && event.pid > 0
          && processGroupId != null
          && birthMarker != null
          && ownershipToken != null;
        const existing = runtimeInstanceId
          ? await tx.executionProcess.findFirst({
            where: {
              sessionId: event.towerSessionId,
              runtimeInstanceId,
            launchClaimNumber,
            },
            select: { id: true, cleanupState: true },
          })
          : null;
        // started is a generation barrier and may be retried after a caller
        // timeout. Do not create a second row or advance the launch claim a
        // second time when the first transaction already committed.
        if (existing) return existing;
        const diagnostic = launchClaimNumber == null
          ? 'New runtime generation did not provide a valid launch claim number'
          : 'New runtime generation did not provide complete process ownership identity';
        const process = await tx.executionProcess.create({
          data: {
            sessionId: event.towerSessionId,
            launchClaimNumber,
            runtimeInstanceId,
            processGroupId,
            birthMarker,
            ownershipToken,
            cleanupState: identityComplete && launchClaimNumber != null ? 'ACTIVE' : 'QUARANTINED',
            cleanupError: identityComplete && launchClaimNumber != null ? null : diagnostic,
            cleanupAttemptCount: identityComplete && launchClaimNumber != null ? 0 : 1,
            nextCleanupRetryAt: identityComplete && launchClaimNumber != null
              ? null
              : new Date(Date.now() + 5 * 60_000),
            pid: Number.isInteger(event.pid) && event.pid > 0 ? event.pid : null,
          },
          select: { id: true, cleanupState: true },
        });
        if (launchClaimNumber == null) {
          await tx.session.update({
            where: { id: event.towerSessionId },
            data: {
              runtimeLaunchState: RUNTIME_LAUNCH_STATES.QUARANTINED,
              runtimeLaunchProcessCount: { increment: 1 },
              runtimeLaunchDiagnostic: diagnostic,
              runtimeLaunchDiagnosticCount: { increment: 1 },
              runtimeLaunchNextDiagnosticAt: new Date(Date.now() + 5 * 60_000),
            },
          });
          return process;
        }
        const resolved = await tx.session.updateMany({
          where: {
            id: event.towerSessionId,
            runtimeLaunchClaimCount: launchClaimNumber,
            runtimeLaunchResolvedCount: launchClaimNumber - 1,
          },
          data: {
            runtimeLaunchState: identityComplete
              ? RUNTIME_LAUNCH_STATES.PROCESS_RECORDED
              : RUNTIME_LAUNCH_STATES.QUARANTINED,
            runtimeLaunchResolvedCount: { increment: 1 },
            runtimeLaunchProcessCount: { increment: 1 },
            runtimeLaunchDiagnostic: identityComplete ? null : diagnostic,
            runtimeLaunchDiagnosticCount: identityComplete ? undefined : { increment: 1 },
            runtimeLaunchNextDiagnosticAt: identityComplete ? null : new Date(Date.now() + 5 * 60_000),
          },
        });
        if (resolved.count !== 1) {
          throw new ServiceError(
            `Runtime process started outside launch claim ${launchClaimNumber}`,
            'RUNTIME_LAUNCH_CLAIM_MISMATCH',
            409,
          );
        }
        return process;
        });
      } catch (error) {
        if (launchClaimNumber != null) {
          this.clearPendingRuntimeEventExpiryTimer(eventKey(
            event.towerSessionId,
            event.runtimeInstanceId,
            launchClaimNumber,
          ));
          this.pendingRuntimeProcessEvents.delete(eventKey(
            event.towerSessionId,
            event.runtimeInstanceId,
            launchClaimNumber,
          ));
        }
        await this.quarantineRuntimeProcessEvent(
          event,
          `Runtime started persistence failed permanently: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      if (
        typeof event.runtimeInstanceId === 'string'
        && event.runtimeInstanceId.length > 0
        && !['CONFIRMED', 'QUARANTINED'].includes(processRecord.cleanupState)
      ) {
        this.runtimeProcessIds.set(
          eventKey(event.towerSessionId, event.runtimeInstanceId, launchClaimNumber ?? 0),
          processRecord.id,
        );
      }
      if (launchClaimNumber == null) return;
      const key = eventKey(event.towerSessionId, event.runtimeInstanceId, launchClaimNumber);
      const buffered = this.pendingRuntimeProcessEvents.get(key);
      if (buffered) {
        this.pendingRuntimeProcessEvents.delete(key);
        this.clearPendingRuntimeEventExpiryTimer(key);
        for (const bufferedEvent of buffered) {
          await this.handleRuntimeProcessEvent(bufferedEvent.event);
        }
      }
      return;
    }

    const processKey = launchClaimNumber != null
      ? eventKey(event.towerSessionId, event.runtimeInstanceId, launchClaimNumber)
      : undefined;
    const processId = processKey ? this.runtimeProcessIds.get(processKey) : undefined;
    const processRecord = launchClaimNumber != null
      ? await prisma.executionProcess.findFirst({
        where: {
          ...(processId ? { id: processId } : {}),
          sessionId: event.towerSessionId,
          runtimeInstanceId: event.runtimeInstanceId,
          launchClaimNumber,
        },
        select: {
          id: true,
          launchClaimNumber: true,
          processGroupId: true,
          birthMarker: true,
          ownershipToken: true,
          cleanupState: true,
        },
      })
      : null;
    if (!processRecord) {
      if (launchClaimNumber == null) {
        await this.quarantineRuntimeProcessEvent(
          event,
          'Runtime process event arrived before started persistence without a valid launch claim',
        );
        return;
      }
      const key = eventKey(event.towerSessionId, event.runtimeInstanceId, launchClaimNumber);
      const pending = this.pendingRuntimeProcessEvents.get(key) ?? [];
      if (pending.length >= PENDING_RUNTIME_EVENTS_PER_KEY
        || this.pendingRuntimeEventCount() >= PENDING_RUNTIME_EVENTS_GLOBAL) {
        this.pendingRuntimeProcessEvents.delete(key);
        this.clearPendingRuntimeEventExpiryTimer(key);
        await this.quarantineRuntimeProcessEvent(event, 'Runtime process event buffer overflow; event generation quarantined');
        return;
      }
      pending.push({ event, expiresAt: Date.now() + PENDING_RUNTIME_EVENT_TTL_MS });
      this.pendingRuntimeProcessEvents.set(key, pending);
      if (!this.pendingRuntimeEventExpiryTimers.has(key)) {
        const timer = setTimeout(() => {
          this.pendingRuntimeProcessEvents.delete(key);
          this.pendingRuntimeEventExpiryTimers.delete(key);
        }, PENDING_RUNTIME_EVENT_TTL_MS);
        timer.unref?.();
        this.pendingRuntimeEventExpiryTimers.set(key, timer);
      }
      // A process event without its started row is durable evidence that the
      // launch handoff was interrupted. Keep the session blocked/quarantined
      // while retaining the in-memory event for a later started retry; never
      // treat an empty process set as a safe pre-child failure.
      await prisma.session.updateMany({
        where: {
          id: event.towerSessionId,
          // A concurrent started transaction has already established durable
          // ownership; it must win over this stale no-row observation.
          runtimeLaunchState: {
            notIn: [RUNTIME_LAUNCH_STATES.PROCESS_RECORDED, RUNTIME_LAUNCH_STATES.REUSED],
          },
        },
        data: {
          runtimeLaunchState: RUNTIME_LAUNCH_STATES.QUARANTINED,
          runtimeLaunchDiagnostic: 'Runtime process event arrived before started persistence',
          runtimeLaunchDiagnosticCount: { increment: 1 },
          runtimeLaunchNextDiagnosticAt: new Date(Date.now() + 5 * 60_000),
        },
      }).catch((error) => {
        this.logSessionError('session.processEventBeforeStarted', error, {
          sessionId: event.towerSessionId,
          runtimeInstanceId: event.runtimeInstanceId,
          eventType: event.type,
        });
      });
      return;
    }
    if (launchClaimNumber == null || processRecord.launchClaimNumber !== launchClaimNumber) {
      await this.quarantineRuntimeProcessEvent(
        event,
        'Runtime process event launch claim did not match its persisted generation',
      );
      return;
    }
    if (!processId && !['CONFIRMED', 'QUARANTINED'].includes(processRecord.cleanupState)) {
      this.runtimeProcessIds.set(processKey!, processRecord.id);
    }

    if (event.type === 'tree_cleanup_completed') {
      await this.markRuntimeProcessCleanupState(
        event.towerSessionId,
        event.runtimeInstanceId,
        'CONFIRMED',
        undefined,
        launchClaimNumber,
      );
      if (processKey) this.runtimeProcessIds.delete(processKey);
      return;
    }
    const rootExitConfirmsCleanup = processRecord != null
      && processRecord.processGroupId == null
      && processRecord.birthMarker == null
      && processRecord.ownershipToken == null;
    await prisma.executionProcess.updateMany({
      where: {
        sessionId: event.towerSessionId,
        runtimeInstanceId: event.runtimeInstanceId,
        ...(launchClaimNumber != null ? { launchClaimNumber } : {}),
      },
      data: {
        exitCode: event.exitCode,
      },
    }).catch((error) => {
      this.logSessionError('session.processExit', error, {
        sessionId: event.towerSessionId,
        processId,
        exitCode: event.exitCode,
      });
    });
    if (rootExitConfirmsCleanup) {
      await this.markRuntimeProcessCleanupState(
        event.towerSessionId,
        event.runtimeInstanceId,
        'CONFIRMED',
        undefined,
        launchClaimNumber,
      );
    } else if (processRecord) {
      await this.markRuntimeProcessCleanupPending(
        event.towerSessionId,
        event.runtimeInstanceId,
        launchClaimNumber,
      );
    }
    if (rootExitConfirmsCleanup) {
      if (processKey) this.runtimeProcessIds.delete(processKey);
    }
  }

  private pendingRuntimeEventCount(): number {
    let count = 0;
    for (const events of this.pendingRuntimeProcessEvents.values()) count += events.length;
    return count;
  }

  private clearPendingRuntimeProcessEvents(sessionId: string): void {
    for (const key of this.pendingRuntimeProcessEvents.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.pendingRuntimeProcessEvents.delete(key);
        this.clearPendingRuntimeEventExpiryTimer(key);
      }
    }
  }

  private clearPendingRuntimeEventExpiryTimer(key: string): void {
    const timer = this.pendingRuntimeEventExpiryTimers.get(key);
    if (timer) clearTimeout(timer);
    this.pendingRuntimeEventExpiryTimers.delete(key);
  }

  private prunePendingRuntimeProcessEvents(): void {
    const now = Date.now();
    for (const [key, events] of this.pendingRuntimeProcessEvents) {
      const live = events.filter((entry) => entry.expiresAt > now);
      if (live.length === 0) {
        this.pendingRuntimeProcessEvents.delete(key);
        this.clearPendingRuntimeEventExpiryTimer(key);
      }
      else if (live.length !== events.length) this.pendingRuntimeProcessEvents.set(key, live);
    }
  }

  private async quarantineRuntimeProcessEvent(event: RuntimeProcessEvent, diagnostic: string): Promise<void> {
    await prisma.session.updateMany({
      where: { id: event.towerSessionId },
      data: {
        runtimeLaunchState: RUNTIME_LAUNCH_STATES.QUARANTINED,
        runtimeLaunchDiagnostic: diagnostic,
        runtimeLaunchDiagnosticCount: { increment: 1 },
        runtimeLaunchNextDiagnosticAt: new Date(Date.now() + 5 * 60_000),
      },
    }).catch((error) => {
      this.logSessionError('session.processEventQuarantine', error, {
        sessionId: event.towerSessionId,
        runtimeInstanceId: event.runtimeInstanceId,
      });
    });
  }

  private async markRuntimeProcessCleanupPending(
    sessionId: string,
    runtimeInstanceId: string,
    launchClaimNumber?: number | null,
  ): Promise<void> {
    if (!Number.isInteger(launchClaimNumber) || launchClaimNumber! <= 0) {
      await this.quarantinePersistedRuntimeProcess(
        sessionId,
        runtimeInstanceId,
        'Runtime cleanup transition is missing launchClaimNumber; owner remains quarantined',
        launchClaimNumber,
      );
      return;
    }
    const resolvedClaim = launchClaimNumber as number;
    await prisma.executionProcess.updateMany({
      where: {
        sessionId,
        runtimeInstanceId,
        launchClaimNumber: resolvedClaim,
        cleanupState: { notIn: ['CONFIRMED', 'QUARANTINED'] },
      },
      data: {
        cleanupState: 'PENDING',
        cleanupError: null,
        nextCleanupRetryAt: null,
      },
    }).catch((error) => {
      this.logSessionError('session.processCleanupPending', error, { sessionId, runtimeInstanceId });
    });
  }

  private async markRuntimeProcessCleanupState(
    sessionId: string,
    runtimeInstanceId: string,
    cleanupState: 'CONFIRMED' | 'FAILED',
    cleanupError?: string,
    launchClaimNumber?: number | null,
  ): Promise<void> {
    if (!Number.isInteger(launchClaimNumber) || launchClaimNumber! <= 0) {
      await this.quarantinePersistedRuntimeProcess(
        sessionId,
        runtimeInstanceId,
        'Runtime cleanup transition is missing launchClaimNumber; owner remains quarantined',
        launchClaimNumber,
      );
      return;
    }
    const resolvedClaim = launchClaimNumber as number;
    await prisma.$transaction(async (tx) => {
      const record = await tx.executionProcess.findFirst({
        where: { sessionId, runtimeInstanceId, launchClaimNumber: resolvedClaim },
        select: { id: true, cleanupAttemptCount: true, cleanupState: true },
      });
      if (!record) return;
      if (cleanupState === 'CONFIRMED') {
        if (record.cleanupState === 'QUARANTINED') return;
        await tx.executionProcess.updateMany({
          where: { id: record.id, sessionId, runtimeInstanceId, launchClaimNumber: resolvedClaim },
          data: {
            cleanupState,
            cleanupError: null,
            nextCleanupRetryAt: null,
          },
        });
        this.runtimeProcessIds.delete(eventKey(sessionId, runtimeInstanceId, resolvedClaim));
        return;
      }
      const attempt = record.cleanupAttemptCount + 1;
      const delay = PROCESS_CLEANUP_RETRY_DELAYS_MS[
        Math.min(attempt - 1, PROCESS_CLEANUP_RETRY_DELAYS_MS.length - 1)
      ]!;
      await tx.executionProcess.updateMany({
        where: {
          id: record.id,
          sessionId,
          runtimeInstanceId,
          launchClaimNumber: resolvedClaim,
          cleanupState: { notIn: ['CONFIRMED', 'QUARANTINED'] },
        },
        data: {
          cleanupState,
          cleanupError: cleanupError?.slice(0, 2_000) ?? 'Process cleanup failed',
          cleanupAttemptCount: attempt,
          nextCleanupRetryAt: new Date(Date.now() + delay),
        },
      });
    }).catch((error) => {
      this.logSessionError('session.processCleanupState', error, { sessionId, runtimeInstanceId, cleanupState });
    });
  }

  private normalizeRuntimeType(value: unknown): RuntimeType {
    return value === RuntimeType.ACP ? RuntimeType.ACP : RuntimeType.CLI;
  }

  private injectAgentTowerMcpServiceEnv(sessionId: string, env: ExecutionEnv): void {
    const serviceEnv: Record<string, string> = {
      AGENT_TOWER_SESSION_ID: sessionId,
    };
    serviceEnv[AGENT_API_CREDENTIAL_ENV] = createAgentApiCredential({
      sessionId,
      invocationId: env.get('AGENT_TOWER_INVOCATION_ID') ?? null,
    });
    if (process.env.AGENT_TOWER_URL) {
      serviceEnv.AGENT_TOWER_URL = process.env.AGENT_TOWER_URL;
    }
    if (process.env.AGENT_TOWER_PORT) {
      serviceEnv.AGENT_TOWER_PORT = process.env.AGENT_TOWER_PORT;
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
  private async autoCommitChanges(sessionId: string, generation?: number): Promise<void> {
    try {
      if (!this.isCurrentGeneration(sessionId, generation)) return;
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: { workspace: true },
      });
      if (!this.isCurrentGeneration(sessionId, generation)) return;
      if (!session?.workspace || isMainDirectoryWorkspace(session.workspace)) return;
      if (!session.workspace.worktreePath) return;

      const worktreePath = session.workspace.worktreePath;

      const status = await execGit(worktreePath, ['status', '--porcelain']);
      if (!this.isCurrentGeneration(sessionId, generation)) return;
      if (!status.trim()) return;

      await execGit(worktreePath, ['add', '-A']);
      if (!this.isCurrentGeneration(sessionId, generation)) return;
      await execGit(worktreePath, [
        'commit', '-m',
        `auto-commit: uncommitted changes from session ${sessionId.slice(0, 8)}`,
      ]);
      if (!this.isCurrentGeneration(sessionId, generation)) return;

      console.log(`[SessionManager] Auto-committed changes for session ${sessionId}`);
    } catch (error) {
      // auto-commit 失败不应阻断后续流程
      console.warn(
        `[SessionManager] Auto-commit failed for session ${sessionId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  private scheduleSnapshotPersist(sessionId: string, status?: SessionStatus): void {
    this.dirtySnapshots.add(sessionId);
    if (status) {
      this.pendingSnapshotStatus.set(sessionId, status);
    }
    if (this.snapshotFlushTimers.has(sessionId)) {
      return;
    }

    const nextTimer = setTimeout(() => {
      this.snapshotFlushTimers.delete(sessionId);
      if (DEBUG_SNAPSHOT) {
        console.log(`[SessionManager:snapshot] checkpoint fire sessionId=${sessionId}`);
      }
      this.flushSnapshotPersist(sessionId).catch((error) => {
        console.error(`[SessionManager] Snapshot checkpoint failed for ${sessionId}:`, error);
        if ((error as { code?: string } | null)?.code === 'P2025') {
          this.releaseSnapshotPersistenceState(sessionId);
          return;
        }
        if (sessionMsgStoreManager.has(sessionId)) {
          this.scheduleSnapshotPersist(sessionId);
        }
      });
    }, SessionManager.SNAPSHOT_CHECKPOINT_MS);
    this.snapshotFlushTimers.set(sessionId, nextTimer);
    if (DEBUG_SNAPSHOT) {
      console.log(
        `[SessionManager:snapshot] checkpoint scheduled sessionId=${sessionId} ms=${SessionManager.SNAPSHOT_CHECKPOINT_MS} status=${status ?? 'none'}`
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
      .then(() => this.enqueueSessionPersistenceWrite(() => this.persistSnapshot(sessionId)));

    this.snapshotFlushChains.set(sessionId, current);
    try {
      await current;
    } finally {
      if (this.snapshotFlushChains.get(sessionId) === current) {
        this.snapshotFlushChains.delete(sessionId);
      }
    }
  }

  private async enqueueSessionPersistenceWrite(write: () => Promise<void>): Promise<void> {
    const queued = this.sessionPersistenceWriterChain
      .catch(() => {
        // Keep the global writer alive after an isolated persistence failure.
      })
      .then(write);
    this.sessionPersistenceWriterChain = queued;

    try {
      await queued;
    } finally {
      if (this.sessionPersistenceWriterChain === queued) {
        this.sessionPersistenceWriterChain = Promise.resolve();
      }
    }
  }

  private async persistSnapshot(sessionId: string): Promise<void> {
    const pendingStatus = this.pendingSnapshotStatus.get(sessionId);
    const wasDirty = this.dirtySnapshots.delete(sessionId);
    this.pendingSnapshotStatus.delete(sessionId);

    if (!pendingStatus && !wasDirty) {
      return;
    }

    try {
      if (DEBUG_SNAPSHOT) {
        console.log(
          `[SessionManager:snapshot] flush start sessionId=${sessionId} pendingStatus=${pendingStatus ?? 'none'} dirty=${wasDirty}`
        );
      }

      const msgStore = sessionMsgStoreManager.get(sessionId);
      if (!msgStore) {
        if (pendingStatus) {
          await prisma.session.update({
            where: { id: sessionId },
            data: { status: pendingStatus },
          });
        }
        return;
      }

      const snapshot = msgStore.getSnapshot();
      const serializedSnapshot = JSON.stringify(snapshot);
      const snapshotHash = createHash('sha256').update(serializedSnapshot).digest('hex');
      const snapshotChanged = this.persistedSnapshotHashes.get(sessionId) !== snapshotHash;
      const tokenUsage = snapshotChanged ? this.extractTokenUsageFromSnapshot(snapshot) : null;

      if (!snapshotChanged && !pendingStatus) {
        return;
      }

      await prisma.session.update({
        where: { id: sessionId },
        data: {
          ...(pendingStatus ? { status: pendingStatus } : {}),
          ...(snapshotChanged ? {
            logSnapshot: serializedSnapshot,
            ...(tokenUsage ? { tokenUsage: JSON.stringify(tokenUsage) } : {}),
          } : {}),
        },
      });

      if (snapshotChanged) {
        this.persistedSnapshotHashes.set(sessionId, snapshotHash);
      }
      if (DEBUG_SNAPSHOT) {
        console.log(
          `[SessionManager:snapshot] flush persisted sessionId=${sessionId} status=${pendingStatus ?? 'unchanged'} entries=${snapshot.entries.length} changed=${snapshotChanged}`
        );
      }
    } catch (error) {
      if (wasDirty) {
        this.dirtySnapshots.add(sessionId);
      }
      if (pendingStatus && !this.pendingSnapshotStatus.has(sessionId)) {
        this.pendingSnapshotStatus.set(sessionId, pendingStatus);
      }
      throw error;
    }
  }

  private releaseSnapshotPersistenceState(sessionId: string): void {
    const timer = this.snapshotFlushTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.snapshotFlushTimers.delete(sessionId);
    }
    this.dirtySnapshots.delete(sessionId);
    this.pendingSnapshotStatus.delete(sessionId);
    this.persistedSnapshotHashes.delete(sessionId);
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

  private appendUserMessageEntry(
    session: SessionExecutionRecord,
    message: string,
    entryId?: string,
  ): string {
    const sessionId = session.id;
    const isNewStore = !sessionMsgStoreManager.has(sessionId);
    const msgStore = sessionMsgStoreManager.getOrCreate(sessionId);

    if (isNewStore && session.logSnapshot) {
      try {
        msgStore.restoreFromSnapshot(JSON.parse(session.logSnapshot) as NormalizedConversation);
      } catch (error) {
        console.error(`[SessionManager] Failed to restore snapshot for session ${sessionId}:`, error);
      }
    }

    // Heal index drift caused by previously failed patches (e.g. invalid value).
    const preflightSnapshot = msgStore.getSnapshot();
    const expectedIndex = preflightSnapshot.entries.length;
    const currentIndex = msgStore.entryIndex.current();
    if (currentIndex !== expectedIndex) {
      if (DEBUG_SNAPSHOT) {
        console.warn(
          `[SessionManager:snapshot] rebase entryIndex sessionId=${sessionId} currentIndex=${currentIndex} expectedIndex=${expectedIndex}`
        );
      }
      msgStore.entryIndex.startFrom(expectedIndex);
    }

    // Queue retries may reach this point after the patch was already applied
    // but before its durable userEntryId update. Reusing the stable id makes
    // the replay a no-op instead of appending the same message twice.
    if (entryId) {
      const existing = preflightSnapshot.entries.find((entry) => entry.id === entryId);
      if (existing) return entryId;
    }

    const userEntry = createUserMessage(message, entryId);
    const userIndex = msgStore.entryIndex.next();
    const userPatch = addNormalizedEntry(userIndex, userEntry);
    if (DEBUG_SNAPSHOT) {
      console.log(
        `[SessionManager:snapshot] userPatch sessionId=${sessionId} index=${userIndex} currentIndex=${msgStore.entryIndex.current()}`
      );
    }
    const userPatchSeq = msgStore.pushPatch(userPatch);
    // Emit directly to EventBus — a previous pipeline may have been destroyed
    // before the queued turn starts, leaving no MsgStore patch listener.
    this.eventBus.emit('session:patch', { sessionId, patch: userPatch, seq: userPatchSeq });
    return userEntry.id;
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
  private async handleSessionExit(
    sessionId: string,
    exitCode?: number,
    options: {
      logicalCompletion?: boolean;
      generation?: number;
      runtimeInstanceId?: string;
    } = {},
  ): Promise<void> {
    const generation = options.generation ?? this.sessionGenerations.get(sessionId);
    await this.externalSessionPersistence.get(sessionId);
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { purpose: true, context: true, conversationId: true },
    });

    // exitCode 非 0 且非 undefined 视为失败
    const isFailed = typeof exitCode === 'number' && exitCode !== 0;
    const finalStatus = isFailed ? SessionStatus.FAILED : SessionStatus.COMPLETED;

    // Persist and broadcast logical completion before any auto-commit or
    // provider cleanup work. This is the user-visible fast path; the later
    // PTY cleanup and post-exit work remain best-effort background work.
    if (options.logicalCompletion) {
      await this.flushSnapshotPersist(sessionId, finalStatus);
      if (!this.isCurrentGeneration(sessionId, generation)) {
        this.releaseAutoCommitGate(sessionId);
        return;
      }
      this.eventBus.emit('session:completed', { sessionId, status: finalStatus });
    }

    if (isFailed) {
      console.warn(`[SessionManager] Session ${sessionId} exited with code ${exitCode}, marking as FAILED`);
      writeErrorLog({
        level: 'warn',
        source: 'session.exit',
        message: `Session exited with non-zero code ${exitCode}`,
        metadata: { sessionId, exitCode },
      });
    }

    if (!isFailed && session?.purpose === SessionPurpose.CHAT && this.isCurrentGeneration(sessionId, generation)) {
      try {
        const result = await this.artifactService.publishDeclaredArtifacts(sessionId);
        if (result.failed > 0) {
          console.warn(
            `[SessionManager] Failed to publish ${result.failed} declared artifact(s) for session ${sessionId}`,
          );
        }
      } catch (error) {
        console.warn(
          `[SessionManager] Failed to publish declared artifacts for session ${sessionId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    if (session?.context === SessionContext.CONVERSATION || session?.conversationId) {
      this.releaseAutoCommitGate(sessionId);
      if (!options.logicalCompletion) {
        await this.flushSnapshotPersist(sessionId, finalStatus);
      }
      if (session.conversationId) {
        await prisma.conversation.update({
          where: { id: session.conversationId },
          data: { lastActiveAt: new Date() },
        }).catch(() => {
          // Conversation may have been deleted while the process exited.
        });
      }
      if (!options.logicalCompletion) {
        this.eventBus.emit('session:completed', { sessionId, status: finalStatus });
      }
    } else if (session?.purpose === SessionPurpose.COMMIT_MSG) {
      // COMMIT_MSG session: 只需持久化快照，然后提取 commit message
      this.releaseAutoCommitGate(sessionId);
      if (!options.logicalCompletion) {
        await this.flushSnapshotPersist(sessionId, finalStatus);
      }
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
      if (!options.logicalCompletion) {
        this.eventBus.emit('session:completed', { sessionId, status: finalStatus });
      }
    } else {
      // 正常 CHAT session: autoCommit → 持久化 → 检查 Task 推进 → 触发 commit message 生成
      if (!isFailed && this.isCurrentGeneration(sessionId, generation)) {
        try {
          await this.autoCommitChanges(sessionId, generation);
        } finally {
          // Follow-up requests wait for this boundary before advancing the
          // generation, so no Git operation can overlap the new turn.
          this.releaseAutoCommitGate(sessionId);
        }
      } else {
        this.releaseAutoCommitGate(sessionId);
      }
      // A follow-up may still be validating its session/provider. Keep the
      // old generation inside this boundary until the follow-up either fails
      // (and releases the reservation) or advances the generation and enters
      // its new execution.
      await this.waitForFollowUpReservation(sessionId);
      if (!this.isCurrentGeneration(sessionId, generation)) return;
      if (!options.logicalCompletion) {
        await this.flushSnapshotPersist(sessionId, finalStatus);
      }
      // 通知前端 session 状态（DB 状态已更新）
      if (!options.logicalCompletion) {
        this.eventBus.emit('session:completed', { sessionId, status: finalStatus });
      }

      if (!this.isCurrentGeneration(sessionId, generation)) return;

      const handledByTeamRun = await this.teamReconciler.handleSessionExit(sessionId, options.runtimeInstanceId);
      if (!this.isCurrentGeneration(sessionId, generation)) return;

      if (!isFailed) {
        if (!handledByTeamRun) {
          await this.checkTaskAutoAdvance(sessionId);
        }
        if (!this.isCurrentGeneration(sessionId, generation)) return;

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
    if (this.isCurrentGeneration(sessionId, generation)) {
      sessionMsgStoreManager.delete(sessionId);
      this.releaseSnapshotPersistenceState(sessionId);
      this.clearPendingRuntimeProcessEvents(sessionId);
    }
  }

  private beginSessionExecution(sessionId: string): void {
    this.clearTerminalState(sessionId);
    this.sessionGenerations.set(sessionId, (this.sessionGenerations.get(sessionId) ?? 0) + 1);
  }

  private invalidateSessionGeneration(sessionId: string): void {
    this.sessionGenerations.set(sessionId, (this.sessionGenerations.get(sessionId) ?? 0) + 1);
  }

  private clearTerminalState(sessionId: string): void {
    this.terminalSessions.delete(sessionId);
  }

  private startSessionFinalization(
    sessionId: string,
    exitCode?: number,
    options: { logicalCompletion?: boolean; runtimeInstanceId?: string } = {},
  ): void {
    if (options.logicalCompletion) {
      this.reserveAutoCommitGate(sessionId);
    }
    const source = options.logicalCompletion ? 'session.logicalCompletion' : 'session.postExit';
    const generation = this.sessionGenerations.get(sessionId);
    const finalization = this.handleSessionExit(sessionId, exitCode, { ...options, generation })
      .catch((error) => {
        this.releaseAutoCommitGate(sessionId);
        console.error(`[SessionManager] ${source} handling failed for ${sessionId}:`, error);
        writeErrorLog({
          level: 'error',
          source,
          message: `Session finalization failed for session ${sessionId}`,
          error,
          metadata: { sessionId, exitCode },
        });
      })
      .finally(() => {
        if (this.sessionFinalizations.get(sessionId) === finalization) {
          this.sessionFinalizations.delete(sessionId);
        }
        this.maybeClearTerminalState(sessionId);
      });
    this.sessionFinalizations.set(sessionId, finalization);
  }

  private maybeClearTerminalState(sessionId: string): void {
    if (this.sessionFinalizations.has(sessionId)) return;
    this.terminalSessions.delete(sessionId);
  }

  private isCurrentGeneration(sessionId: string, generation?: number): boolean {
    return generation === undefined || this.sessionGenerations.get(sessionId) === generation;
  }

  private reserveAutoCommitGate(sessionId: string): void {
    if (this.pendingAutoCommits.has(sessionId)) return;
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    this.pendingAutoCommits.set(sessionId, gate);
    this.pendingAutoCommitResolvers.set(sessionId, resolveGate);
  }

  private releaseAutoCommitGate(sessionId: string): void {
    const resolveGate = this.pendingAutoCommitResolvers.get(sessionId);
    if (resolveGate) resolveGate();
    this.pendingAutoCommitResolvers.delete(sessionId);
    this.pendingAutoCommits.delete(sessionId);
  }

  private async waitForPendingAutoCommit(sessionId: string): Promise<void> {
    await this.pendingAutoCommits.get(sessionId);
  }

  private reserveFollowUp(sessionId: string): {
    previous: Promise<void>;
    release: () => void;
  } {
    const previous = this.followUpReservations.get(sessionId) ?? Promise.resolve();
    let resolveReservation!: () => void;
    const reservation = new Promise<void>((resolve) => {
      resolveReservation = resolve;
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      resolveReservation();
      this.followUpReservationReleases.delete(release);
      if (this.followUpReservations.get(sessionId) === reservation) {
        this.followUpReservations.delete(sessionId);
      }
    };
    this.followUpReservations.set(sessionId, reservation);
    this.followUpReservationReleases.add(release);
    return { previous, release };
  }

  private reserveSessionAction(sessionId: string): {
    previous: Promise<void>;
    release: () => void;
  } {
    const previous = this.sessionActionReservations.get(sessionId) ?? Promise.resolve();
    let resolveReservation!: () => void;
    const reservation = new Promise<void>((resolve) => {
      resolveReservation = resolve;
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      resolveReservation();
      this.sessionActionReservationReleases.delete(release);
      if (this.sessionActionReservations.get(sessionId) === reservation) {
        this.sessionActionReservations.delete(sessionId);
      }
    };
    this.sessionActionReservations.set(sessionId, reservation);
    this.sessionActionReservationReleases.add(release);
    return { previous, release };
  }

  private reserveInitialStartOperation(sessionId: string): {
    waitFor: <T>(operation: () => Promise<T>) => Promise<T>;
    throwIfStopped: () => void;
    release: () => void;
  } {
    const controller = new AbortController();
    const operations = this.initialStartOperations.get(sessionId) ?? new Set<AbortController>();
    operations.add(controller);
    this.initialStartOperations.set(sessionId, operations);
    if ((this.sessionStopIntentCounts.get(sessionId) ?? 0) > 0) {
      controller.abort(this.sessionStartStoppedError());
    }
    let released = false;
    return {
      waitFor: <T>(operation: () => Promise<T>) => this.waitForInitialStartOperation(operation, controller.signal),
      throwIfStopped: () => controller.signal.throwIfAborted(),
      release: () => {
        if (released) return;
        released = true;
        operations.delete(controller);
        if (operations.size === 0 && this.initialStartOperations.get(sessionId) === operations) {
          this.initialStartOperations.delete(sessionId);
        }
      },
    };
  }

  private async waitForInitialStartOperation<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let rejectStopped!: (reason: unknown) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStopped = reject;
    });
    const onStop = () => rejectStopped(signal.reason ?? this.sessionStartStoppedError());
    signal.addEventListener('abort', onStop, { once: true });
    try {
      // Attach the race before starting fallible work. The second signal check
      // prevents a stop published during setup from launching the operation,
      // while the race continues to observe any operation that already started.
      const pending = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation();
      });
      return await Promise.race([pending, stopped]);
    } finally {
      signal.removeEventListener('abort', onStop);
    }
  }

  private beginSessionStopIntent(sessionId: string): () => void {
    this.sessionStopIntentCounts.set(sessionId, (this.sessionStopIntentCounts.get(sessionId) ?? 0) + 1);
    const error = this.sessionStartStoppedError();
    for (const controller of this.initialStartOperations.get(sessionId) ?? []) {
      controller.abort(error);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.sessionStopIntentCounts.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.sessionStopIntentCounts.set(sessionId, remaining);
      else this.sessionStopIntentCounts.delete(sessionId);
    };
  }

  private sessionStartStoppedError(): ServiceError {
    return new ServiceError(
      'Session start was stopped before runtime admission',
      'SESSION_NOT_ADMITTED',
      409,
    );
  }

  private async waitForFollowUpReservation(sessionId: string): Promise<void> {
    // Follow-ups can queue behind one another. Re-check after each reservation
    // resolves so a finalizer never observes only an earlier queue item.
    while (true) {
      const reservation = this.followUpReservations.get(sessionId);
      if (!reservation) return;
      await reservation;
      if (this.followUpReservations.get(sessionId) === reservation) return;
    }
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
