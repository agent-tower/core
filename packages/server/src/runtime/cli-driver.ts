import { randomUUID } from 'node:crypto';
import { RuntimeType } from '@agent-tower/shared';
import { EventBus } from '../core/event-bus.js';
import {
  getExecutor,
  getExecutorByProvider,
  ExecutorConfigurationError,
  ExecutorNotFoundError,
  isPreChildProcessFailure,
  markPreChildProcessFailure,
  normalizeExecutorStartError,
  getSpawnCleanupOwner,
  type BaseExecutor,
  type CancellationToken,
  type SpawnCleanupOwner,
  type SpawnedChild,
} from '../executors/index.js';
import { AgentPipeline } from '../pipeline/agent-pipeline.js';
import { AgentType } from '../types/index.js';
import type {
  DriverSession,
  DriverTurn,
  RuntimeDriver,
  RuntimeDriverEventSink,
  RuntimeOpenInput,
  RuntimeRunTurnInput,
  RuntimeTurnOutcome,
} from './contracts.js';
import { AgentRuntimeError } from './errors.js';
import { createCliParser } from './cli-parser.js';

const LOGICAL_COMPLETION_GRACE_MS = 250;
type BufferedProcessEvent = Parameters<RuntimeDriverEventSink['process']>[0];
interface ActiveCliTurn {
  turnId: string;
  runtimeInstanceId: string;
  pipeline?: AgentPipeline;
  cancel?: CancellationToken;
  completion: Promise<RuntimeTurnOutcome>;
  resolve: (outcome: RuntimeTurnOutcome) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  /** Root wrapper exit was observed, even if complete tree cleanup is unverified. */
  processExitObserved: boolean;
  processExited: boolean;
  treeCleanupConfirmed: boolean;
  processExitCompletion: Promise<void>;
  resolveProcessExit: () => void;
  requestProcessStop?: () => void;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  offRawExit?: { dispose(): void };
  spawnCleanupOwner?: SpawnCleanupOwner;
  verifyTreeCleanup?: () => boolean;
  disposeTreeCleanupChannel?: () => void;
  /** Process events wait behind the durable started barrier for this generation. */
  processEvents: BufferedProcessEvent[];
  processEventsReleased: boolean;
  processEventFlush?: Promise<void>;
  processEventSink?: RuntimeDriverEventSink;
  launchClaimNumber?: number;
  cleanups: Array<() => void>;
}

export class CliRuntimeDriver implements RuntimeDriver {
  readonly type = RuntimeType.CLI;

  async open(input: RuntimeOpenInput): Promise<DriverSession> {
    return new CliDriverSession(input);
  }
}

class CliDriverSession implements DriverSession {
  readonly capabilities = {
    loadSession: true,
    terminalInput: true,
    terminalResize: true,
    permissions: false,
  };
  private active?: ActiveCliTurn;
  private readonly pendingCleanup = new Set<ActiveCliTurn>();
  private currentRuntimeInstanceId = randomUUID();
  private currentExternalSessionId?: string;
  /** Admission closes immediately, while cleanup remains open until the real tree exits. */
  private admissionClosed = false;
  private closePromise?: Promise<void>;

  constructor(private readonly input: RuntimeOpenInput) {
    this.currentExternalSessionId = input.externalSessionId ?? undefined;
  }

  get runtimeInstanceId(): string {
    return this.currentRuntimeInstanceId;
  }

  get externalSessionId(): string | undefined {
    return this.currentExternalSessionId;
  }

  async runTurn(input: RuntimeRunTurnInput, sink: RuntimeDriverEventSink): Promise<DriverTurn> {
    if (this.admissionClosed) {
      throw new AgentRuntimeError('runtime_disposed', 'prompt', 'CLI runtime session is closed', true);
    }
    if (this.active) {
      if (this.active.processExitObserved && !this.active.treeCleanupConfirmed) {
        throw new AgentRuntimeError(
          'process_exit_pending',
          'prompt',
          'Previous CLI process tree exited without confirmed cleanup channel completion',
          true,
        );
      }
      if (!this.active.processExited && !this.active.settled) {
        throw new AgentRuntimeError(
          'process_exit_pending',
          'prompt',
          'Previous CLI process tree has not confirmed exit',
          true,
        );
      }
      if (!this.active.settled) {
        throw new AgentRuntimeError('turn_already_running', 'prompt', 'CLI turn is already running', false);
      }
    }
    this.cleanupActive();

    let executor: BaseExecutor;
    try {
      executor = this.resolveExecutor();
    } catch (error) {
      throw markPreChildProcessFailure(error);
    }
    const spawnConfig = {
      workingDir: this.input.workingDir,
      prompt: input.prompt,
      env: this.input.env,
    };
    let spawnResult: SpawnedChild;
    try {
      const resumeId = input.resumeExternalSessionId ?? this.currentExternalSessionId;
      if (resumeId && executor.spawnFollowUp) {
        try {
          spawnResult = await executor.spawnFollowUp(spawnConfig, resumeId);
        } catch (error) {
          if (!isPreChildProcessFailure(error)) throw error;
          spawnResult = await executor.spawn(spawnConfig);
        }
      } else {
        spawnResult = await executor.spawn(spawnConfig);
      }
    } catch (error) {
      const owner = getSpawnCleanupOwner(error);
      if (owner) {
        const pending = createActiveTurn(input.turnId, randomUUID(), input.launchClaimNumber);
        pending.spawnCleanupOwner = owner;
        pending.requestProcessStop = owner.requestStop;
        owner.processExit.then(() => {
          pending.processExited = true;
          pending.resolveProcessExit();
          owner.dispose();
          owner.disposeTreeCleanupChannel?.();
        }).catch(() => undefined);
        void pending.completion.catch(() => undefined);
        this.active = pending;
        this.settleFailure(pending, error);
      }
      throw normalizeExecutorStartError(error);
    }

    this.currentRuntimeInstanceId = randomUUID();
    const active = createActiveTurn(input.turnId, this.currentRuntimeInstanceId, input.launchClaimNumber);
    // Early-exit replay can reject before RuntimeCoordinator receives the
    // DriverTurn and attaches its terminal handlers.
    void active.completion.catch(() => undefined);
    this.active = active;

    try {
      // Install the raw exit handoff and reusable stop owner before the first
      // durable started event. A persistence failure must still be closable.
      this.attachSpawnedTurn(active, spawnResult, input.msgStore, sink);
      await sink.process({
        type: 'started',
        runtimeInstanceId: active.runtimeInstanceId,
        launchClaimNumber: input.launchClaimNumber ?? 1,
        pid: spawnResult.pid,
        processGroupId: spawnResult.processGroupId,
        birthMarker: spawnResult.birthMarker,
        ownershipToken: spawnResult.ownershipToken,
      });
      active.processEventsReleased = true;
      await this.flushProcessEvents(active, sink);
    } catch (error) {
      // Preserve early exit evidence even when the started row is rejected.
      // A later recovery/start retry can replay these events; the owner stays
      // attached until the wrapper confirms the complete tree exit.
      active.processEventsReleased = true;
      await this.flushProcessEvents(active, sink);
      void active.completion.catch(() => undefined);
      try {
        active.requestProcessStop?.();
      } catch {
        // The host error remains authoritative.
      }
      this.settleFailure(active, error);
      throw error;
    }

    return { completion: active.completion };
  }

  async cancelTurn(turnId: string): Promise<void> {
    const active = this.active;
    if (!active || active.turnId !== turnId) return;
    active.cancel?.cancel();
    active.pipeline?.destroy();
    this.settleFailure(
      active,
      new AgentRuntimeError('turn_cancelled', 'cancel', 'CLI turn was cancelled', true),
    );
  }

  writeInput(data: string): void {
    this.active?.pipeline?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.active?.pipeline?.resize(cols, rows);
  }

  async close(): Promise<void> {
    this.admissionClosed = true;
    if (this.closePromise) return this.closePromise;

    const closeAttempt = this.closeActive();
    this.closePromise = closeAttempt;
    try {
      await closeAttempt;
    } finally {
      // A timeout is a cleanup failure, not confirmation. Keep admission closed
      // but allow a later recovery/shutdown attempt to retry the same owner.
      if (this.closePromise === closeAttempt) this.closePromise = undefined;
    }
  }

  private async closeActive(): Promise<void> {
    const targets = [
      ...(this.active ? [this.active] : []),
      ...this.pendingCleanup,
    ];
    if (targets.length === 0) return;
    const closeError = new AgentRuntimeError('runtime_disposed', 'close', 'CLI runtime session was closed', true);
    for (const active of targets) {
      active.requestProcessStop?.();
      this.settleFailure(active, closeError);
      await Promise.race([
        active.completion.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      await this.waitForProcessExit(active);
      if (active.processEventFlush) await active.processEventFlush;
      if (active.processEvents.length > 0 && active.processEventSink) {
        await this.flushProcessEvents(active, active.processEventSink);
      }
      this.cleanupTurnResources(active);
      if (active.processEvents.length > 0) {
        this.pendingCleanup.add(active);
        throw new AgentRuntimeError(
          'runtime_cleanup_pending',
          'close',
          'CLI process events were not durably acknowledged after tree exit',
          true,
        );
      }
      this.pendingCleanup.delete(active);
      if (this.active === active) this.active = undefined;
    }
  }

  private async waitForProcessExit(active: ActiveCliTurn): Promise<void> {
    if (active.processExitObserved && !active.treeCleanupConfirmed) {
      throw new AgentRuntimeError(
        'runtime_cleanup_pending',
        'close',
        'CLI wrapper exited without parent-owned tree cleanup completion',
        true,
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        active.processExitCompletion,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(
            new AgentRuntimeError(
              'process_exit_timeout',
              'close',
              'CLI process tree did not confirm termination before the shutdown deadline',
              true,
            ),
          ), 2_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private attachSpawnedTurn(
    active: ActiveCliTurn,
    spawnResult: SpawnedChild,
    msgStore: RuntimeRunTurnInput['msgStore'],
    sink: RuntimeDriverEventSink,
  ): void {
    active.processEventSink = sink;
    active.verifyTreeCleanup = spawnResult.verifyTreeCleanup;
    active.disposeTreeCleanupChannel = spawnResult.disposeTreeCleanupChannel;
    const bus = new EventBus();
    const onStdout = ({ data }: { sessionId: string; data: string }) => sink.stream({ type: 'stdout', data });
    const onPatch = ({ patch, seq }: { sessionId: string; patch: unknown[]; seq: number }) => {
      sink.stream({ type: 'conversation_patch', patch: patch as never, seq });
    };
    const onSessionId = ({ agentSessionId }: { sessionId: string; agentSessionId: string }) => {
      this.currentExternalSessionId = agentSessionId;
      sink.stream({ type: 'external_session_id', externalSessionId: agentSessionId });
    };
    const onCompleted = () => {
      this.settleSuccess(active, {});
      this.schedulePipelineCleanup(active);
    };
    const onFailed = () => {
      this.settleFailure(
        active,
        new AgentRuntimeError('turn_failed', 'prompt', 'CLI agent reported a failed turn', true),
      );
      this.schedulePipelineCleanup(active);
    };
    const onExit = ({ exitCode }: { sessionId: string; exitCode?: number }) => {
      if (typeof exitCode === 'number' && exitCode !== 0) {
        this.settleFailure(
          active,
          new AgentRuntimeError('process_exit', 'runtime', `CLI process exited with code ${exitCode}`, true),
        );
      } else {
        this.settleSuccess(active, {});
      }
      this.cleanupTurnResources(active);
    };

    bus.on('session:stdout', onStdout);
    bus.on('session:patch', onPatch);
    bus.on('session:sessionId', onSessionId);
    bus.on('session:turn-completed', onCompleted);
    bus.on('session:turn-failed', onFailed);
    bus.on('session:exit', onExit);
    active.cleanups.push(
      () => bus.off('session:stdout', onStdout),
      () => bus.off('session:patch', onPatch),
      () => bus.off('session:sessionId', onSessionId),
      () => bus.off('session:turn-completed', onCompleted),
      () => bus.off('session:turn-failed', onFailed),
      () => bus.off('session:exit', onExit),
    );

    let processExitReported = false;
    const reportProcessExit = (exitCode: number, signal?: NodeJS.Signals | null) => {
      if (processExitReported) return;
      processExitReported = true;
      active.processExitObserved = true;
      try {
        active.treeCleanupConfirmed = spawnResult.verifyTreeCleanup?.() ?? true;
      } catch {
        active.treeCleanupConfirmed = false;
      }
      if (active.treeCleanupConfirmed) {
        active.processExited = true;
        active.resolveProcessExit();
        this.pendingCleanup.delete(active);
      } else {
        // A root exit without matched evidence is an unresolved generation;
        // keep it reachable and block admission/shutdown until recovered.
        this.pendingCleanup.add(active);
      }
      active.processEvents.push(
        {
          type: 'exited',
          runtimeInstanceId: active.runtimeInstanceId,
          exitCode,
          signal,
          launchClaimNumber: active.launchClaimNumber,
        },
      );
      if (active.treeCleanupConfirmed) {
        active.processEvents.push({
          type: 'tree_cleanup_completed',
          runtimeInstanceId: active.runtimeInstanceId,
          launchClaimNumber: active.launchClaimNumber,
        });
      }
      if (active.processEventsReleased) {
        void this.flushProcessEvents(active, sink);
      }
    };
    active.offRawExit = spawnResult.pty.onExit(({ exitCode, signal }) => {
      reportProcessExit(exitCode, signal as NodeJS.Signals | null | undefined);
    });
    active.requestProcessStop = () => {
      active.cancel?.cancel();
      active.pipeline?.destroy();
      try {
        // Pipeline.destroy() owns the normal stop path. Repeating this call on
        // recovery is deliberate: it re-issues the controlled PTY cleanup
        // without ever signaling an unknown PID/PGID.
        spawnResult.pty.kill();
      } catch {
        // The process-exit promise remains authoritative.
      }
    };

    const earlyEvents = spawnResult.takeEarlyEvents?.() ?? [];
    const earlyExit = earlyEvents.find((event) => event.type === 'exit');
    if (earlyExit?.type === 'exit') reportProcessExit(earlyExit.exitCode);

    const parser = createCliParser(this.input.agentType as AgentType, this.input.workingDir, msgStore);
    const pipeline = new AgentPipeline(
      this.input.towerSessionId,
      spawnResult.pty,
      parser,
      msgStore,
      bus,
      earlyEvents,
    );
    active.pipeline = pipeline;
    active.cancel = spawnResult.cancel;
    if (!pipeline.isAlive) this.cleanupTurnResources(active);
  }

  private async flushProcessEvents(
    active: ActiveCliTurn,
    sink: RuntimeDriverEventSink,
  ): Promise<void> {
    if (!active.processEventsReleased || active.processEvents.length === 0) return;
    if (active.processEventFlush) return active.processEventFlush;
    const flush = (async () => {
      while (active.processEvents.length > 0) {
        const event = active.processEvents[0]!;
        try {
          await sink.process(event);
        } catch {
          // Keep the event and owner reachable. A rejected started/cleanup
          // write is evidence of unresolved launch state, never permission to
          // discard the generation or declare cleanup safe.
          return;
        }
        active.processEvents.shift();
      }
      if (active.processExited) this.cleanupRawExitTracking(active);
    })();
    active.processEventFlush = flush;
    try {
      await flush;
    } finally {
      if (active.processEventFlush === flush) active.processEventFlush = undefined;
    }
  }

  private resolveExecutor(): BaseExecutor {
    const agentType = this.input.agentType as AgentType;
    let executor: BaseExecutor | undefined;
    try {
      executor = this.input.providerId
        ? getExecutorByProvider(this.input.providerId)
        : getExecutor(agentType, this.input.variant);
    } catch (error) {
      throw new ExecutorConfigurationError(agentType, error, this.input.providerId);
    }
    if (!executor) {
      throw new ExecutorNotFoundError(agentType, this.input.providerId);
    }
    return executor;
  }

  private settleSuccess(active: ActiveCliTurn, outcome: RuntimeTurnOutcome): void {
    if (active.settled) return;
    active.settled = true;
    active.resolve(outcome);
  }

  private settleFailure(active: ActiveCliTurn, error: unknown): void {
    if (active.settled) return;
    active.settled = true;
    active.reject(error);
  }

  private schedulePipelineCleanup(active: ActiveCliTurn): void {
    if (active.cleanupTimer) return;
    active.cleanupTimer = setTimeout(() => {
      active.cleanupTimer = undefined;
      // Logical completion is a terminal turn for one-shot CLI commands, but
      // the child may keep its stdin/app-server open after emitting
      // turn.completed. Use the executor's full stop owner so cancellation,
      // wrapper signaling, and descendant cleanup all run through one path.
      active.requestProcessStop?.();
      this.cleanupTurnResources(active);
    }, LOGICAL_COMPLETION_GRACE_MS);
    active.cleanupTimer.unref?.();
  }

  private cleanupTurnResources(active: ActiveCliTurn): void {
    if (active.cleanupTimer) clearTimeout(active.cleanupTimer);
    active.cleanupTimer = undefined;
    for (const cleanup of active.cleanups.splice(0)) cleanup();
    active.pipeline = undefined;
    active.cancel = undefined;
    if (active.processExited) {
      this.cleanupRawExitTracking(active);
    }
  }

  private cleanupRawExitTracking(active: ActiveCliTurn): void {
    if (!active.treeCleanupConfirmed || active.processEvents.length > 0 || active.processEventFlush) return;
    active.offRawExit?.dispose();
    active.offRawExit = undefined;
    active.spawnCleanupOwner?.dispose();
    active.spawnCleanupOwner = undefined;
    active.disposeTreeCleanupChannel?.();
    active.disposeTreeCleanupChannel = undefined;
    active.verifyTreeCleanup = undefined;
    active.processEventSink = undefined;
    this.pendingCleanup.delete(active);
  }

  private cleanupActive(): void {
    const active = this.active;
    if (!active) return;
    active.pipeline?.destroy();
    this.cleanupTurnResources(active);
    if (active.processExited || active.settled) {
      if (!active.processExited) this.pendingCleanup.add(active);
      this.active = undefined;
    }
  }
}

function createActiveTurn(turnId: string, runtimeInstanceId: string, launchClaimNumber?: number): ActiveCliTurn {
  let resolve!: (outcome: RuntimeTurnOutcome) => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<RuntimeTurnOutcome>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let resolveProcessExit!: () => void;
  const processExitCompletion = new Promise<void>((resolveExit) => {
    resolveProcessExit = resolveExit;
  });
  return {
    turnId,
    runtimeInstanceId,
    launchClaimNumber,
    completion,
    resolve,
    reject,
    settled: false,
    processExitObserved: false,
    processExited: false,
    treeCleanupConfirmed: false,
    processExitCompletion,
    resolveProcessExit,
    cleanups: [],
    processEvents: [],
    processEventsReleased: false,
  };
}
