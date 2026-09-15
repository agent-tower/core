import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import {
  RuntimeType,
  type RuntimeCapabilities,
  type RuntimePermissionOption,
} from '@agent-tower/shared';
import { getProviderById, getProviderRuntimeType } from '../../executors/providers.js';
import { markPreChildProcessFailure } from '../../executors/start-error.js';
import { MsgStore, setSessionId, type JsonPatch } from '../../output/index.js';
import { buildMcpConfigResponse } from '../../services/mcp-config.service.js';
import { writeErrorLog } from '../../utils/error-log.js';
import type {
  DriverSession,
  DriverTurn,
  RuntimeDriver,
  RuntimeDriverEventSink,
  RuntimeOpenInput,
  RuntimeRunTurnInput,
} from '../contracts.js';
import { AgentRuntimeError } from '../errors.js';
import { AcpProcessManager, type AcpProcessExit } from './process-manager.js';
import { acpLaunchCleanupRegistry } from './launch-cleanup-registry.js';
import { getAcpAgentDefinition } from './agents/registry.js';
import type { AcpAgentDefinition, AcpAgentProfile } from './agents/types.js';
import { reconcileAcpHistoryEntries } from './history-reconciler.js';
import { AcpProjector } from './projector.js';

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_SESSION_BOOTSTRAP_UPDATES = 1_000;
/**
 * Adapter stderr is unbounded third-party output that can echo whole
 * environment blocks, private paths and user data. A crash only needs its
 * fatal line, so persist a controlled tail summary instead of the raw excerpt.
 */
const EXIT_DIAGNOSTIC_MAX_LINES = 12;
const EXIT_DIAGNOSTIC_MAX_LINE_CHARS = 300;
const EXIT_DIAGNOSTIC_MAX_CHARS = 1_200;
const TURN_FAILURE_MAX_CHARS = 4_096;
/** Reserved room for the "...[N chars omitted]..." marker inside a bound. */
const OMISSION_MARKER_BUDGET = 48;

/**
 * Debug-only instrumentation for the session/load ↔ reconcile path.
 * Off by default; only logs, never changes behaviour.
 * Enable with DEBUG_ACP_RECONCILE=true to measure how often `session/load`
 * replay produces a whole-array `replace /entries` frame and how large it is.
 */
const DEBUG_ACP_RECONCILE = process.env.DEBUG_ACP_RECONCILE === 'true';

interface PendingPermission {
  optionIds: Set<string>;
  resolve: (response: acp.RequestPermissionResponse) => void;
  signal: AbortSignal;
  onAbort: () => void;
  sink: RuntimeDriverEventSink;
}

interface ProcessCleanupEvidence {
  sink: RuntimeDriverEventSink;
  runtimeInstanceId: string;
  launchClaimNumber: number;
  confirmation?: Promise<void>;
}

export class AcpRuntimeDriver implements RuntimeDriver {
  readonly type = RuntimeType.ACP;

  async open(input: RuntimeOpenInput, sink: RuntimeDriverEventSink): Promise<DriverSession> {
    return AcpDriverSession.open(input, sink);
  }
}

class AcpDriverSession implements DriverSession {
  private connection?: acp.ClientConnection;
  private processManager?: AcpProcessManager;
  private currentSink?: RuntimeDriverEventSink;
  private currentTurnId?: string;
  private currentExternalSessionId?: string;
  private sessionReady = false;
  private sessionBootstrapUpdates?: SessionNotification[];
  private closed = false;
  private readonly launchCleanupOwnerIds = new Set<string>();
  private transportResetPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private transportGeneration = 0;
  private readonly processCleanupEvidence = new WeakMap<AcpProcessManager, ProcessCleanupEvidence>();
  private readonly pendingProcessManagers = new Set<AcpProcessManager>();
  private lastProcessExit?: { generation: number; exit: AcpProcessExit };
  private negotiatedCapabilities: RuntimeCapabilities = {
    loadSession: false,
    terminalInput: false,
    terminalResize: false,
    permissions: true,
  };
  private supportsSessionResume = false;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly cancelledTurnIds = new Set<string>();
  private currentRuntimeInstanceId = randomUUID();

  private constructor(
    private readonly input: RuntimeOpenInput,
    private readonly definition: AcpAgentDefinition,
    private readonly providerProfile: AcpAgentProfile,
  ) {
    this.currentExternalSessionId = input.externalSessionId ?? undefined;
  }

  static async open(input: RuntimeOpenInput, sink: RuntimeDriverEventSink): Promise<AcpDriverSession> {
    const provider = input.providerId ? getProviderById(input.providerId) : null;
    if (input.providerId && !provider) {
      throw markPreChildProcessFailure(new AgentRuntimeError(
        'provider_config_invalid',
        'provider_config',
        `Provider '${input.providerId}' was not found`,
        false,
      ));
    }
    if (provider && provider.agentType !== input.agentType) {
      throw markPreChildProcessFailure(new AgentRuntimeError(
        'provider_config_invalid',
        'provider_config',
        `Provider '${provider.name}' does not belong to agent '${input.agentType}'`,
        false,
      ));
    }
    if (provider && getProviderRuntimeType(provider) !== RuntimeType.ACP) {
      throw markPreChildProcessFailure(new AgentRuntimeError(
        'provider_config_invalid',
        'provider_config',
        `Provider '${provider.name}' is configured for the '${getProviderRuntimeType(provider)}' runtime`,
        false,
      ));
    }
    let definition: AcpAgentDefinition;
    let profile: AcpAgentProfile;
    try {
      definition = getAcpAgentDefinition(input.agentType);
      profile = definition.projectProvider(provider, input.env.getFullEnv());
    } catch (error) {
      throw markPreChildProcessFailure(error);
    }
    const session = new AcpDriverSession(input, definition, profile);
    await session.connect(sink, input.launchClaimNumber ?? 1, input.admissionSignal);
    return session;
  }

  get capabilities(): RuntimeCapabilities {
    return this.negotiatedCapabilities;
  }

  get runtimeInstanceId(): string {
    return this.currentRuntimeInstanceId;
  }

  get externalSessionId(): string | undefined {
    return this.currentExternalSessionId;
  }

  async runTurn(turn: RuntimeRunTurnInput, sink: RuntimeDriverEventSink): Promise<DriverTurn> {
    if (this.closed) {
      throw new AgentRuntimeError('connection_closed', 'prompt', 'ACP connection is closed', true);
    }
    if (!this.connection) {
      await this.connect(sink, turn.launchClaimNumber ?? 1, turn.admissionSignal);
    }
    this.assertAdmissionActive(turn.admissionSignal, 'prompt');
    const connection = this.connection;
    if (!connection) {
      throw new AgentRuntimeError('connection_closed', 'prompt', 'ACP connection is closed', true);
    }
    const generation = this.transportGeneration;
    this.assertTransportCurrent(generation, connection, turn.admissionSignal, 'prompt');
    if (this.currentTurnId) {
      throw new AgentRuntimeError('turn_already_running', 'prompt', 'ACP turn is already running', false);
    }
    this.currentTurnId = turn.turnId;
    this.currentSink = sink;
    const projector = new AcpProjector(turn.msgStore, sink);
    this.projector = projector;

    try {
      await this.ensureAgentSession(turn, sink);
    } catch (error) {
      this.clearTurn(turn.turnId);
      throw error;
    }

    try {
      // Even a sessionReady fast path yields at the await above. Disposal can
      // win in that microtask window, so prompt needs its own final gate.
      this.assertTransportCurrent(generation, connection, turn.admissionSignal, 'prompt');
    } catch (error) {
      this.clearTurn(turn.turnId);
      throw error;
    }
    const request = connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: this.requireExternalSessionId(),
      prompt: [{
        type: 'text',
        text: this.providerProfile.appendPrompt
          ? `${turn.prompt}${this.providerProfile.appendPrompt}`
          : turn.prompt,
      }],
    });
    const completion = request.then(
      (response) => ({ stopReason: response.stopReason }),
      async (error) => {
        if (this.cancelledTurnIds.has(turn.turnId)) {
          return { stopReason: 'cancelled' };
        }
        const normalized = this.explainTurnFailure(normalizeAcpError(error, 'prompt'), generation);
        if (shouldResetAcpTransport(normalized)) {
          await this.resetTransport(connection).catch(() => undefined);
        }
        projector.projectError(normalized);
        throw normalized;
      },
    ).finally(() => {
      this.invalidatePermissions(sink);
      this.clearTurn(turn.turnId);
    });
    return { completion };
  }

  async cancelTurn(turnId: string): Promise<void> {
    if (!this.connection || this.currentTurnId !== turnId || !this.currentExternalSessionId) return;
    this.cancelledTurnIds.add(turnId);
    this.invalidatePermissions(this.currentSink);
    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this.currentExternalSessionId,
    }).catch((error) => {
      throw normalizeAcpError(error, 'cancel');
    });
  }

  async resolvePermission(requestId: string, optionId: string): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new AgentRuntimeError('permission_not_found', 'permission', 'Permission request is no longer active', false);
    }
    if (!pending.optionIds.has(optionId)) {
      throw new AgentRuntimeError('permission_option_invalid', 'permission', 'Permission option was not offered', false);
    }
    this.pendingPermissions.delete(requestId);
    pending.signal.removeEventListener('abort', pending.onAbort);
    pending.resolve({ outcome: { outcome: 'selected', optionId } });
    pending.sink.stream({ type: 'permission_invalidated', requestId });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.invalidatePermissions(this.currentSink);
    const close = this.resetTransport().catch((error) => {
      if (this.closePromise === close) this.closePromise = undefined;
      throw error;
    });
    this.closePromise = close;
    try {
      await close;
    } finally {
      // A launch-helper cleanup failure must not leave a permanently resolved
      // close promise: a later lifecycle boundary can retry the helper.
      if (
        this.closePromise === close
        && (this.pendingProcessManagers.size > 0 || this.launchCleanupOwnerIds.size > 0)
      ) {
        this.closePromise = undefined;
      }
    }
  }

  private projector?: AcpProjector;

  private async connect(
    sink: RuntimeDriverEventSink,
    launchClaimNumber = this.input.launchClaimNumber ?? 1,
    admissionSignal?: AbortSignal,
  ): Promise<void> {
    if (this.transportResetPromise) await this.transportResetPromise;
    this.assertAdmissionActive(admissionSignal, 'initialize');
    if (this.connection) return;
    if (this.processManager || this.pendingProcessManagers.size > 0) await this.resetTransport();
    this.assertAdmissionActive(admissionSignal, 'initialize');
    const generation = this.transportGeneration;
    let launch: Awaited<ReturnType<AcpAgentDefinition['resolveLaunch']>>;
    try {
      launch = await this.definition.resolveLaunch(this.input, this.providerProfile);
    } catch (error) {
      throw markPreChildProcessFailure(error);
    }
    const launchCleanupOwnerId = launch.cleanup
      ? acpLaunchCleanupRegistry.register(launch.cleanup, `${this.input.agentType}:${this.input.towerSessionId}`)
      : undefined;
    if (launchCleanupOwnerId) this.launchCleanupOwnerIds.add(launchCleanupOwnerId);
    let manager: AcpProcessManager | undefined;
    let connection: acp.ClientConnection | undefined;
    let processStarted = false;
    const runtimeInstanceId = randomUUID();
    try {
      this.assertStartupCurrent(generation, admissionSignal, 'initialize', true);
      manager = new AcpProcessManager({
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        maxStdoutFrameBytes: this.definition.maxStdoutFrameBytes,
        transformStdoutFrame: this.definition.transformStdoutFrame,
      });
      this.processManager = manager;
      this.currentRuntimeInstanceId = runtimeInstanceId;
      // No await occurs between the generation check and AcpProcessManager's
      // synchronous spawn call, so disposal cannot cross this final spawn gate.
      this.assertStartupCurrent(generation, admissionSignal, 'spawn', true);
      const streams = await manager.start();
      await sink.process({
        type: 'started',
        runtimeInstanceId,
        launchClaimNumber,
        pid: streams.pid,
        processGroupId: streams.processGroupId,
        birthMarker: streams.birthMarker,
        ownershipToken: streams.ownershipToken,
      });
      processStarted = true;
      this.processCleanupEvidence.set(manager, {
        sink,
        runtimeInstanceId,
        launchClaimNumber,
      });
      this.assertStartupCurrent(generation, admissionSignal, 'initialize', false);
      manager.onExit((exit) => {
        // Record before anything awaits: the SDK tears the connection down by
        // itself when the adapter's stdout closes and its close() is
        // first-come-first-served, so the generic "ACP connection closed" error
        // otherwise reaches the turn and the adapter's own fatal reason is lost.
        this.recordProcessExit(generation, runtimeInstanceId, exit);
        void (async () => {
          await sink.process({
            type: 'exited',
            runtimeInstanceId,
            exitCode: exit.exitCode,
            signal: exit.signal,
            launchClaimNumber,
          }).catch(() => undefined);
          if (!this.closed && this.transportGeneration === generation && this.processManager === manager) {
            const activeConnection = this.connection;
            activeConnection?.close(
              new AgentRuntimeError(
                'process_exit',
                'runtime',
                describeAcpProcessExit(exit),
                true,
              ),
            );
            await this.resetTransport(activeConnection, generation);
          }
        })().catch(() => undefined);
      });
      const app = acp.client({ name: 'agent-tower' })
        .onNotification(acp.methods.client.session.update, async ({ params }) => {
          if (!connection || !this.isTransportCurrent(generation, connection)) return;
          if (this.sessionBootstrapUpdates) {
            this.sessionBootstrapUpdates.push(params);
            if (this.sessionBootstrapUpdates.length > MAX_SESSION_BOOTSTRAP_UPDATES) {
              this.sessionBootstrapUpdates.shift();
            }
            return;
          }
          if (params.sessionId !== this.currentExternalSessionId) return;
          this.projector?.project(params);
        })
        .onRequest(acp.methods.client.session.requestPermission, async ({ params, signal }) => {
          if (!connection || !this.isTransportCurrent(generation, connection)) {
            return { outcome: { outcome: 'cancelled' } };
          }
          return this.handlePermission(params, signal);
        });
      connection = app.connect(acp.ndJsonStream(streams.input, streams.output));
      this.assertStartupCurrent(generation, admissionSignal, 'initialize', false);
      this.connection = connection;
      const clientCapabilities = mergeClientCapabilities(
        this.definition.clientCapabilities?.(this.providerProfile),
      );
      const initialize = connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'agent-tower', version: '0.5.4' },
        clientCapabilities,
      });
      const response = await withTimeout(
        initialize,
        this.definition.initializeTimeoutMs ?? CONNECT_TIMEOUT_MS,
        'ACP initialize timed out',
      );
      this.assertTransportCurrent(generation, connection, admissionSignal, 'initialize');
      if (response.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new AgentRuntimeError('protocol_mismatch', 'initialize', 'ACP protocol version mismatch', false);
      }
      try {
        await this.definition.authenticate?.(connection.agent, response, this.providerProfile);
      } catch (error) {
        throw normalizeAcpError(error, 'authenticate');
      }
      this.assertTransportCurrent(generation, connection, admissionSignal, 'authenticate');
      this.negotiatedCapabilities = {
        loadSession: response.agentCapabilities?.loadSession === true,
        terminalInput: false,
        terminalResize: false,
        permissions: true,
      };
      this.supportsSessionResume = response.agentCapabilities?.sessionCapabilities?.resume != null;
      const monitoredConnection = connection;
      void monitoredConnection.closed.then(
        () => this.handleUnexpectedConnectionClose(monitoredConnection),
        () => this.handleUnexpectedConnectionClose(monitoredConnection),
      );
    } catch (error) {
      if (this.transportGeneration === generation && (this.processManager === manager || this.connection === connection)) {
        await this.resetTransport(connection, generation).catch(() => undefined);
      } else {
        connection?.close();
        let cleanupError: unknown;
        if (processStarted && manager) {
          try {
            await this.stopAndConfirmProcessTree(manager);
          } catch (error) {
            cleanupError = error;
          }
        }
        if (launchCleanupOwnerId) await this.cleanupLaunchWithRetry(launchCleanupOwnerId);
        if (cleanupError) throw cleanupError;
      }
      throw normalizeAcpError(error, 'initialize');
    }
  }

  private assertAdmissionActive(signal: AbortSignal | undefined, stage: string): void {
    if (this.closed) {
      throw markPreChildProcessFailure(
        new AgentRuntimeError('connection_closed', stage, 'ACP connection is closed', true),
      );
    }
    if (!signal?.aborted) return;
    const reason = signal.reason;
    throw markPreChildProcessFailure(reason instanceof Error
      ? reason
      : new AgentRuntimeError(
          'runtime_admission_cancelled',
          stage,
          'ACP startup admission was cancelled by runtime disposal',
          true,
        ));
  }

  private assertStartupCurrent(
    generation: number,
    signal: AbortSignal | undefined,
    stage: string,
    preChild: boolean,
  ): void {
    let error: Error | undefined;
    if (this.closed) {
      error = new AgentRuntimeError('connection_closed', stage, 'ACP connection is closed', true);
    } else if (this.transportGeneration !== generation) {
      error = new AgentRuntimeError(
        'runtime_generation_stale',
        stage,
        'ACP transport generation changed during startup',
        true,
      );
    } else if (signal?.aborted) {
      error = signal.reason instanceof Error
        ? signal.reason
        : new AgentRuntimeError(
            'runtime_admission_cancelled',
            stage,
            'ACP startup admission was cancelled by runtime disposal',
            true,
          );
    }
    if (!error) return;
    throw preChild ? markPreChildProcessFailure(error) : error;
  }

  private assertTransportCurrent(
    generation: number,
    connection: acp.ClientConnection,
    signal: AbortSignal | undefined,
    stage: string,
  ): void {
    this.assertStartupCurrent(generation, signal, stage, false);
    if (this.connection !== connection) {
      throw new AgentRuntimeError(
        'runtime_generation_stale',
        stage,
        'ACP transport was replaced during startup',
        true,
      );
    }
  }

  private isTransportCurrent(generation: number, connection: acp.ClientConnection): boolean {
    return !this.closed
      && this.transportGeneration === generation
      && this.connection === connection;
  }

  private handleUnexpectedConnectionClose(connection: acp.ClientConnection): void {
    if (this.closed || this.connection !== connection) return;
    const closeReason = readConnectionCloseReason(connection);
    const processExit = this.lastProcessExit?.exit;
    const processDiagnostic = processExit ? buildAcpExitDiagnostic(processExit) : undefined;
    const outputError = typeof this.processManager?.getOutputError === 'function'
      ? this.processManager.getOutputError()
      : undefined;
    const reasonMessage = closeReason instanceof Error ? closeReason.message : String(closeReason);
    const outputErrorMessage = outputError instanceof Error ? outputError.message : outputError ? String(outputError) : undefined;
    const processMessage = processExit && processDiagnostic
      ? describeAcpProcessExit(processExit, processDiagnostic)
      : 'no process exit observed yet';
    const outputMessage = outputErrorMessage ? `; ACP output error: ${outputErrorMessage}` : '';
    const message = `ACP connection closed unexpectedly: ${reasonMessage}${outputMessage}; ${processMessage}`;
    console.error(`[AcpDriver] ${this.input.towerSessionId} turn=${this.currentTurnId ?? 'none'} ${message}`);
    writeErrorLog({
      level: 'error',
      source: 'session.acp.connectionClose',
      message,
      error: closeReason instanceof Error ? closeReason : new Error(String(closeReason)),
      metadata: {
        sessionId: this.input.towerSessionId,
        turnId: this.currentTurnId,
        runtimeInstanceId: this.currentRuntimeInstanceId,
        processExitCode: processExit?.exitCode,
        processSignal: processExit?.signal,
        processStderrSummary: processDiagnostic?.stderrSummary,
        outputError: outputErrorMessage,
      },
    });
    this.invalidatePermissions(this.currentSink);
    void this.resetTransport(connection).catch(() => undefined);
  }

  /**
   * The adapter can end its own process. `AcpProcessManager` already captures
   * its stderr, but the transport's generic "ACP connection closed" failure
   * reaches the turn first, so keep the exit facts here (before any await) and
   * persist them for the next reproduction. A signal-terminated stop reports no
   * exit code, so intentional teardown stays out of the log.
   *
   * One adapter process belongs to one generation, and the first fact observed
   * for it is the one closest to the failure: a duplicate settle (or a late
   * close) must neither overwrite the recorded reason nor add a second log
   * line. A retired generation can also settle after its replacement started,
   * so only a newer generation may replace the recorded evidence.
   */
  private recordProcessExit(generation: number, runtimeInstanceId: string, exit: AcpProcessExit): void {
    const recorded = this.lastProcessExit;
    if (!recorded || generation > recorded.generation) {
      this.lastProcessExit = { generation, exit };
    }
    if (recorded?.generation === generation) return;
    if (typeof exit.exitCode !== 'number' || exit.exitCode === 0) return;
    const diagnostic = buildAcpExitDiagnostic(exit);
    writeErrorLog({
      level: 'error',
      source: 'session.acp.processExit',
      message: describeAcpProcessExit(exit, diagnostic),
      metadata: {
        towerSessionId: this.input.towerSessionId,
        runtimeInstanceId,
        exitCode: exit.exitCode,
        signal: exit.signal,
        stderrChars: exit.stderrExcerpt.length,
        stderrSummary: diagnostic.stderrSummary,
      },
    });
  }

  private explainTurnFailure(error: AgentRuntimeError, generation: number): AgentRuntimeError {
    const evidence = this.lastProcessExit;
    if (!evidence || evidence.generation !== generation) return error;
    // The generic transport error sits at the head and the adapter's fatal line
    // at the tail, so bound both ends instead of dropping the tail.
    const message = boundDiagnosticText(
      `${redactDiagnosticText(error.message)}; ${describeAcpProcessExit(evidence.exit)}`,
      TURN_FAILURE_MAX_CHARS,
    );
    return new AgentRuntimeError(
      'process_exit',
      error.stage,
      message,
      true,
      { cause: error },
    );
  }

  private async resetTransport(
    expectedConnection?: acp.ClientConnection,
    expectedGeneration?: number,
  ): Promise<void> {
    if (this.transportResetPromise) return this.transportResetPromise;
    if (expectedConnection && this.connection !== expectedConnection) return;
    if (expectedGeneration != null && this.transportGeneration !== expectedGeneration) return;

    const connection = this.connection;
    const manager = this.processManager;
    const managers = new Set(this.pendingProcessManagers);
    if (manager) managers.add(manager);
    const cleanupOwnerIds = [...this.launchCleanupOwnerIds];
    this.transportGeneration += 1;
    this.connection = undefined;
    this.processManager = undefined;
    this.sessionReady = false;
    connection?.close();

    const reset = (async () => {
      const stops = await Promise.allSettled(
        [...managers].map((ownedManager) => this.stopAndConfirmProcessTree(ownedManager)),
      );

      // Owned-tree confirmation is the safety-critical result used by
      // admission/recovery. Auxiliary launch cleanup is independent and can
      // be retried without converting a confirmed tree into a failed runtime.
      await Promise.all(cleanupOwnerIds.map((ownerId) => this.cleanupLaunchWithRetry(ownerId)));
      const failedStop = stops.find((result) => result.status === 'rejected');
      if (failedStop?.status === 'rejected') throw failedStop.reason;
    })();
    this.transportResetPromise = reset;
    try {
      await reset;
    } finally {
      if (this.transportResetPromise === reset) this.transportResetPromise = undefined;
    }
  }

  private async confirmProcessTreeCleanup(manager: AcpProcessManager): Promise<void> {
    const evidence = this.processCleanupEvidence.get(manager);
    if (!evidence) return;
    if (evidence.confirmation) return evidence.confirmation;
    const confirmation = evidence.sink.process({
      type: 'tree_cleanup_completed',
      runtimeInstanceId: evidence.runtimeInstanceId,
      launchClaimNumber: evidence.launchClaimNumber,
    });
    evidence.confirmation = confirmation;
    try {
      await confirmation;
    } catch (error) {
      if (evidence.confirmation === confirmation) evidence.confirmation = undefined;
      throw error;
    }
  }

  private async stopAndConfirmProcessTree(manager: AcpProcessManager): Promise<void> {
    try {
      await manager.stop();
      await this.confirmProcessTreeCleanup(manager);
      this.pendingProcessManagers.delete(manager);
    } catch (error) {
      this.pendingProcessManagers.add(manager);
      throw error;
    }
  }

  private async cleanupLaunch(ownerId: string): Promise<void> {
    await acpLaunchCleanupRegistry.runWithImmediateRetries(ownerId);
    // Successful owners are removed from the registry. Keep failed owner IDs
    // attached so a later close/reset can retry the same callback.
    if (!acpLaunchCleanupRegistry.getState(ownerId)) {
      this.launchCleanupOwnerIds.delete(ownerId);
    }
  }

  private async cleanupLaunchWithRetry(ownerId: string): Promise<void> {
    try {
      await this.cleanupLaunch(ownerId);
    } catch (error) {
      console.warn('[AcpRuntimeDriver] Auxiliary launch cleanup scheduled for retry', error);
    }
  }

  private async ensureAgentSession(turn: RuntimeRunTurnInput, sink: RuntimeDriverEventSink): Promise<void> {
    if (this.sessionReady) return;
    const connection = this.connection;
    if (!connection) throw new AgentRuntimeError('connection_closed', 'session', 'ACP connection is closed', true);
    const generation = this.transportGeneration;
    this.assertTransportCurrent(generation, connection, turn.admissionSignal, 'session');
    const requestedExternalId = turn.resumeExternalSessionId ?? this.currentExternalSessionId;
    const mcpServers = buildAcpMcpServers(this.input.env);
    const sessionMetadata = this.definition.sessionMetadata?.(this.providerProfile) ?? {};
    const bootstrapUpdates: SessionNotification[] = [];
    this.sessionBootstrapUpdates = bootstrapUpdates;
    const resumeMode = turn.resumeMode ?? 'load';
    const shouldResumeWithoutHistory = Boolean(requestedExternalId)
      && resumeMode === 'resume'
      && this.supportsSessionResume;
    let resolvedExternalSessionId: string;
    try {
      if (requestedExternalId) {
        if (!shouldResumeWithoutHistory && !this.negotiatedCapabilities.loadSession) {
          throw new AgentRuntimeError('load_unsupported', 'session', 'ACP agent cannot restore this session', false);
        }
        const response = shouldResumeWithoutHistory
          ? await connection.agent.request(acp.methods.agent.session.resume, {
              sessionId: requestedExternalId,
              cwd: this.input.workingDir,
              mcpServers,
              ...sessionMetadata,
            })
          : await connection.agent.request(acp.methods.agent.session.load, {
              sessionId: requestedExternalId,
              cwd: this.input.workingDir,
              mcpServers,
              ...sessionMetadata,
            });
        this.assertTransportCurrent(generation, connection, turn.admissionSignal, 'session');
        await this.definition.configureSession?.(
          connection.agent,
          requestedExternalId,
          response,
          this.providerProfile,
        );
        this.assertTransportCurrent(generation, connection, turn.admissionSignal, 'session');
        resolvedExternalSessionId = requestedExternalId;
      } else {
        const response = await connection.agent.request(acp.methods.agent.session.new, {
          cwd: this.input.workingDir,
          mcpServers,
          ...sessionMetadata,
        });
        this.assertTransportCurrent(generation, connection, turn.admissionSignal, 'session');
        await this.definition.configureSession?.(
          connection.agent,
          response.sessionId,
          response,
          this.providerProfile,
        );
        this.assertTransportCurrent(generation, connection, turn.admissionSignal, 'session');
        resolvedExternalSessionId = response.sessionId;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.assertTransportCurrent(generation, connection, turn.admissionSignal, 'session');
    } finally {
      if (this.sessionBootstrapUpdates === bootstrapUpdates) {
        this.sessionBootstrapUpdates = undefined;
      }
    }
    this.currentExternalSessionId = resolvedExternalSessionId!;
    const externalSessionId = this.requireExternalSessionId();
    turn.msgStore.pushSessionId(externalSessionId);
    const patch = setSessionId(externalSessionId);
    const seq = turn.msgStore.pushPatch(patch);
    sink.stream({ type: 'external_session_id', externalSessionId });
    sink.stream({ type: 'conversation_patch', patch, seq });
    const matchingUpdates = bootstrapUpdates.filter((update) => update.sessionId === externalSessionId);
    // Context-only resume intentionally ignores bootstrap history, including load fallback replay.
    if (requestedExternalId && resumeMode === 'load') {
      this.reconcileLoadedHistory(turn, sink, matchingUpdates);
    } else if (!requestedExternalId) {
      for (const update of matchingUpdates) this.projector?.project(update);
    }
    this.sessionReady = true;
  }

  private reconcileLoadedHistory(
    turn: RuntimeRunTurnInput,
    sink: RuntimeDriverEventSink,
    updates: SessionNotification[],
  ): void {
    if (updates.length === 0) return;
    const replayStore = new MsgStore();
    const replayProjector = new AcpProjector(replayStore, {
      stream: () => undefined,
      process: async () => undefined,
    });
    for (const update of updates) replayProjector.project(update);

    const sessionRef = this.currentExternalSessionId ?? 'unknown';
    // Hoisted so the debug branch never adds an extra getSnapshot() replay.
    const localEntries = turn.msgStore.getSnapshot().entries;
    const replayedEntries = replayStore.getSnapshot().entries;
    const localEntryCount = localEntries.length;
    const replayedEntryCount = replayedEntries.length;
    const mergedEntries = reconcileAcpHistoryEntries(
      localEntries,
      replayedEntries,
      { historyBoundaryEntryId: turn.historyBoundaryEntryId },
    );
    if (!mergedEntries) {
      if (DEBUG_ACP_RECONCILE) {
        console.log(
          `[AcpRuntimeDriver:reconcile] externalSessionId=${sessionRef} resumeMode=load action=skip(no-change) `
          + `replayUpdates=${updates.length} localEntries=${localEntryCount} replayedEntries=${replayedEntryCount}`,
        );
      }
      return;
    }

    const patch: JsonPatch = [{ op: 'replace', path: '/entries', value: mergedEntries }];
    turn.msgStore.entryIndex.startFrom(mergedEntries.length);
    const seq = turn.msgStore.pushPatch(patch);
    sink.stream({ type: 'conversation_patch', patch, seq });
    if (DEBUG_ACP_RECONCILE) {
      console.log(
        `[AcpRuntimeDriver:reconcile] externalSessionId=${sessionRef} resumeMode=load action=replace-all-entries `
        + `replayUpdates=${updates.length} localEntries=${localEntryCount} replayedEntries=${replayedEntryCount} `
        + `mergedEntries=${mergedEntries.length} frameBytes=${JSON.stringify(patch).length} seq=${seq}`,
      );
    }
  }

  private handlePermission(
    params: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const sink = this.currentSink;
    const turnId = this.currentTurnId;
    if (!sink || !turnId || params.sessionId !== this.currentExternalSessionId || signal.aborted) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const options = params.options.map((option) => ({
      optionId: option.optionId,
      name: sanitize(option.name, 1_024),
      kind: normalizePermissionKind(option.kind),
    }));
    if (options.length === 0) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    if (this.providerProfile.permissionMode === 'UNRESTRICTED') {
      const selected = options.find((option) => option.kind === 'allow_once')
        ?? options.find((option) => option.kind === 'allow_always');
      return Promise.resolve(selected
        ? { outcome: { outcome: 'selected', optionId: selected.optionId } }
        : { outcome: { outcome: 'cancelled' } });
    }

    const requestId = randomUUID();
    return new Promise((resolve) => {
      const onAbort = () => {
        const pending = this.pendingPermissions.get(requestId);
        if (!pending) return;
        this.pendingPermissions.delete(requestId);
        pending.sink.stream({ type: 'permission_invalidated', requestId });
        resolve({ outcome: { outcome: 'cancelled' } });
      };
      this.pendingPermissions.set(requestId, {
        optionIds: new Set(options.map((option) => option.optionId)),
        resolve,
        signal,
        onAbort,
        sink,
      });
      signal.addEventListener('abort', onAbort, { once: true });
      sink.stream({
        type: 'permission_requested',
        request: {
          requestId,
          sessionId: this.input.towerSessionId,
          turnId,
          toolCallId: params.toolCall.toolCallId,
          toolName: typeof params.toolCall.kind === 'string' ? params.toolCall.kind : undefined,
          toolSummary: sanitize(params.toolCall.title ?? 'Tool permission requested', 4_096),
          options,
          createdAt: new Date().toISOString(),
        },
      });
    });
  }

  private invalidatePermissions(sink?: RuntimeDriverEventSink): void {
    for (const [requestId, pending] of [...this.pendingPermissions]) {
      this.pendingPermissions.delete(requestId);
      pending.signal.removeEventListener('abort', pending.onAbort);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      (sink ?? pending.sink).stream({ type: 'permission_invalidated', requestId });
    }
  }

  private clearTurn(turnId: string): void {
    this.cancelledTurnIds.delete(turnId);
    if (this.currentTurnId !== turnId) return;
    this.currentTurnId = undefined;
    this.currentSink = undefined;
    this.projector = undefined;
  }

  private requireExternalSessionId(): string {
    if (!this.currentExternalSessionId) {
      throw new AgentRuntimeError('session_missing', 'session', 'ACP session has not been created', false);
    }
    return this.currentExternalSessionId;
  }
}

function mergeClientCapabilities(additional?: acp.ClientCapabilities): acp.ClientCapabilities {
  const session = additional?.session ?? undefined;
  return {
    ...additional,
    session: {
      ...session,
      configOptions: {
        ...(session?.configOptions ?? {}),
        boolean: {},
      },
    },
  };
}

function buildAcpMcpServers(env: import('../../executors/execution-env.js').ExecutionEnv): acp.McpServer[] {
  const runtimeEnv = { ...process.env, ...env.toObject() };
  const config = buildMcpConfigResponse({ env: runtimeEnv });
  return [{
    name: config.serverName,
    command: config.command,
    args: config.args,
    env: Object.entries(config.env).map(([name, value]) => ({ name, value })),
  }];
}

function normalizeAcpError(error: unknown, stage: string): AgentRuntimeError {
  if (error instanceof AgentRuntimeError) return error;
  const message = error instanceof Error ? error.message : 'ACP request failed';
  return new AgentRuntimeError('acp_request_failed', stage, sanitize(message, 4_096), true, {
    cause: error,
  });
}

/**
 * The ACP v1 public interface only exposes a `closed` promise, while the SDK
 * keeps the abort reason behind its private `closedReason()` helper. Read that
 * reason when available so protocol/stream errors are preserved in diagnostics;
 * a plain EOF still reports the SDK's canonical "ACP connection closed" error.
 */
function readConnectionCloseReason(connection: acp.ClientConnection): unknown {
  const candidate = connection as unknown as { closedReason?: () => unknown };
  try {
    return typeof candidate.closedReason === 'function'
      ? candidate.closedReason()
      : new Error('ACP connection closed');
  } catch (error) {
    return error;
  }
}

interface AcpExitDiagnostic {
  /** Always present: "ACP adapter exited with code 1 (signal SIGKILL)". */
  headline: string;
  /** Redacted, tail-bounded stderr; empty when the adapter wrote nothing. */
  stderrSummary: string;
}

/**
 * Keep only what a crash diagnosis needs: the last few non-empty stderr lines
 * (a CLI reports its fatal reason last), redacted and bounded. The raw excerpt
 * is never persisted as-is.
 */
function buildAcpExitDiagnostic(exit: AcpProcessExit): AcpExitDiagnostic {
  const headline = `ACP adapter exited with code ${exit.exitCode ?? 'unknown'}`
    + (exit.signal ? ` (signal ${exit.signal})` : '');
  const tailLines = exit.stderrExcerpt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-EXIT_DIAGNOSTIC_MAX_LINES)
    .map((line) => boundDiagnosticText(redactDiagnosticText(line), EXIT_DIAGNOSTIC_MAX_LINE_CHARS));
  return {
    headline,
    stderrSummary: boundDiagnosticText(tailLines.join('\n'), EXIT_DIAGNOSTIC_MAX_CHARS),
  };
}

function describeAcpProcessExit(exit: AcpProcessExit, diagnostic = buildAcpExitDiagnostic(exit)): string {
  return diagnostic.stderrSummary ? `${diagnostic.headline}: ${diagnostic.stderrSummary}` : diagnostic.headline;
}

/**
 * Explicit redaction for diagnostic excerpts. `error-log` already handles known
 * credential formats, but a failing adapter can echo whole environment blocks,
 * account names and user identities that no generic pattern covers. Redaction
 * keeps the root-cause wording intact (paths collapse to `~`, not disappear).
 */
function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|key|token|secret|ghp|gho|ghs|ghr|xox[baprs])[-_][A-Za-z0-9._-]{8,}\b/gi, '[REDACTED]')
    // Credential-shaped assignment names (OPENAI_API_KEY=..., auth_token: ...).
    .replace(
      /(^|[\s"'(])((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|key|token|secret|password|passwd|credential|cookie|auth)(?:[_-][A-Za-z0-9]+)*)(\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      '$1$2$3[REDACTED]',
    )
    // Environment-variable style assignments (HOME=..., export PATH=...).
    .replace(
      /(^|[\s"'(])([A-Z][A-Z0-9_]{2,})(\s*=\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/g,
      '$1$2$3[REDACTED]',
    )
    // Account names in home directories and e-mail addresses.
    .replace(/(?:\/Users|\/home)\/[^/\s'"]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s'"]+/gi, '~')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');
}

/**
 * Bound a diagnostic while keeping both ends: the head carries the generic
 * failure context and the tail carries the adapter's own fatal line. The
 * result never exceeds `maxChars` code units.
 *
 * The two cut points are pulled inward when they would land inside a surrogate
 * pair. A straight UTF-16 slice used to persist an orphaned half of an emoji,
 * which shows up as a replacement character and can mangle the root-cause line.
 * Pulling inward only shortens the slice, so the bound itself still holds.
 */
function boundDiagnosticText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const headEnd = codePointSafeHeadEnd(value, Math.floor(maxChars / 3));
  const tailChars = Math.max(0, maxChars - headEnd - OMISSION_MARKER_BUDGET);
  const tailStart = codePointSafeTailStart(value, value.length - tailChars);
  const omitted = tailStart - headEnd;
  return `${value.slice(0, headEnd)}\n...[${omitted} chars omitted]...\n${value.slice(tailStart)}`;
}

/** Cut a head slice before, never inside, a surrogate pair. */
function codePointSafeHeadEnd(value: string, end: number): number {
  if (end <= 0) return 0;
  if (end >= value.length) return value.length;
  const keepsPair = isHighSurrogate(value.charCodeAt(end - 1)) && isLowSurrogate(value.charCodeAt(end));
  return keepsPair ? end - 1 : end;
}

/** Start a tail slice after, never inside, a surrogate pair. */
function codePointSafeTailStart(value: string, start: number): number {
  if (start <= 0) return 0;
  if (start >= value.length) return value.length;
  const splitsPair = isLowSurrogate(value.charCodeAt(start)) && isHighSurrogate(value.charCodeAt(start - 1));
  return splitsPair ? start + 1 : start;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function shouldResetAcpTransport(error: AgentRuntimeError): boolean {
  return error.code === 'protocol_violation'
    || error.code === 'connection_closed'
    || error.code === 'process_exit';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AgentRuntimeError('handshake_timeout', 'initialize', message, true)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sanitize(value: string, maxLength: number): string {
  const redacted = value
    .replace(/\b(?:sk|key|token|secret)-[A-Za-z0-9._-]{8,}\b/gi, '[REDACTED]')
    .replace(/(authorization\s*[:=]\s*)([^\s]+)/gi, '$1[REDACTED]');
  return boundDiagnosticText(redacted, maxLength);
}

function normalizePermissionKind(value: string): RuntimePermissionOption['kind'] {
  if (value === 'allow_once' || value === 'allow_always' || value === 'reject_once' || value === 'reject_always') {
    return value;
  }
  return 'unknown' as const;
}
