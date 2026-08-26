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
import type {
  DriverSession,
  DriverTurn,
  RuntimeDriver,
  RuntimeDriverEventSink,
  RuntimeOpenInput,
  RuntimeRunTurnInput,
} from '../contracts.js';
import { AgentRuntimeError } from '../errors.js';
import { AcpProcessManager } from './process-manager.js';
import { acpLaunchCleanupRegistry } from './launch-cleanup-registry.js';
import { getAcpAgentDefinition } from './agents/registry.js';
import type { AcpAgentDefinition, AcpAgentProfile } from './agents/types.js';
import { reconcileAcpHistoryEntries } from './history-reconciler.js';
import { AcpProjector } from './projector.js';

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_SESSION_BOOTSTRAP_UPDATES = 1_000;

interface PendingPermission {
  optionIds: Set<string>;
  resolve: (response: acp.RequestPermissionResponse) => void;
  signal: AbortSignal;
  onAbort: () => void;
  sink: RuntimeDriverEventSink;
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
  private launchCleanupOwnerId?: string;
  private transportResetPromise?: Promise<void>;
  private closePromise?: Promise<void>;
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
    await session.connect(sink);
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
    if (!this.connection) await this.connect(sink, turn.launchClaimNumber ?? 1);
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

    const connection = this.connection;
    if (!connection) {
      this.clearTurn(turn.turnId);
      throw new AgentRuntimeError('connection_closed', 'prompt', 'ACP connection is closed', true);
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
        const normalized = normalizeAcpError(error, 'prompt');
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
      if (this.closePromise === close && this.launchCleanupOwnerId) {
        this.closePromise = undefined;
      }
    }
  }

  private projector?: AcpProjector;

  private async connect(
    sink: RuntimeDriverEventSink,
    launchClaimNumber = this.input.launchClaimNumber ?? 1,
  ): Promise<void> {
    if (this.transportResetPromise) await this.transportResetPromise;
    if (this.closed) {
      throw new AgentRuntimeError('connection_closed', 'initialize', 'ACP connection is closed', true);
    }
    if (this.connection) return;
    if (this.processManager) await this.resetTransport();
    let launch: Awaited<ReturnType<AcpAgentDefinition['resolveLaunch']>>;
    try {
      launch = await this.definition.resolveLaunch(this.input, this.providerProfile);
    } catch (error) {
      throw markPreChildProcessFailure(error);
    }
    this.launchCleanupOwnerId = launch.cleanup
      ? acpLaunchCleanupRegistry.register(launch.cleanup, `${this.input.agentType}:${this.input.towerSessionId}`)
      : undefined;
    const runtimeInstanceId = randomUUID();
    this.currentRuntimeInstanceId = runtimeInstanceId;
    const manager = new AcpProcessManager({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      maxStdoutFrameBytes: this.definition.maxStdoutFrameBytes,
      transformStdoutFrame: this.definition.transformStdoutFrame,
    });
    this.processManager = manager;
    try {
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
      manager.onExit((exit) => {
        void (async () => {
          await sink.process({
            type: 'exited',
            runtimeInstanceId,
            exitCode: exit.exitCode,
            signal: exit.signal,
            launchClaimNumber,
          }).catch(() => undefined);
          if (!this.closed && this.processManager === manager) {
            const connection = this.connection;
            connection?.close(
              new AgentRuntimeError(
                'process_exit',
                'runtime',
                exit.stderrExcerpt || `ACP adapter exited with code ${exit.exitCode ?? 'unknown'}`,
                true,
              ),
            );
            await this.resetTransport(connection);
            await sink.process({
              type: 'tree_cleanup_completed',
              runtimeInstanceId,
              launchClaimNumber,
            });
          }
        })().catch(() => undefined);
      });
      const app = acp.client({ name: 'agent-tower' })
        .onNotification(acp.methods.client.session.update, async ({ params }) => {
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
          return this.handlePermission(params, signal);
        });
      const connection = app.connect(acp.ndJsonStream(streams.input, streams.output));
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
      if (response.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new AgentRuntimeError('protocol_mismatch', 'initialize', 'ACP protocol version mismatch', false);
      }
      try {
        await this.definition.authenticate?.(connection.agent, response, this.providerProfile);
      } catch (error) {
        throw normalizeAcpError(error, 'authenticate');
      }
      this.negotiatedCapabilities = {
        loadSession: response.agentCapabilities?.loadSession === true,
        terminalInput: false,
        terminalResize: false,
        permissions: true,
      };
      this.supportsSessionResume = response.agentCapabilities?.sessionCapabilities?.resume != null;
      void connection.closed.then(
        () => this.handleUnexpectedConnectionClose(connection),
        () => this.handleUnexpectedConnectionClose(connection),
      );
    } catch (error) {
      await this.resetTransport(this.connection).catch(() => undefined);
      throw normalizeAcpError(error, 'initialize');
    }
  }

  private handleUnexpectedConnectionClose(connection: acp.ClientConnection): void {
    if (this.closed || this.connection !== connection) return;
    this.invalidatePermissions(this.currentSink);
    void this.resetTransport(connection).catch(() => undefined);
  }

  private async resetTransport(expectedConnection?: acp.ClientConnection): Promise<void> {
    if (this.transportResetPromise) return this.transportResetPromise;
    if (expectedConnection && this.connection !== expectedConnection) return;

    const connection = this.connection;
    const manager = this.processManager;
    this.connection = undefined;
    this.processManager = undefined;
    this.sessionReady = false;
    connection?.close();

    const reset = (async () => {
      let stopError: unknown;
      try {
        await manager?.stop();
      } catch (error) {
        // Keep a failed manager attached so close/connect can retry its owned
        // process-tree cleanup instead of treating a root exit as confirmed.
        if (manager && !this.processManager) this.processManager = manager;
        stopError = error;
      }

      // Owned-tree confirmation is the safety-critical result used by
      // admission/recovery. Auxiliary launch cleanup is independent and can
      // be retried without converting a confirmed tree into a failed runtime.
      await this.cleanupLaunchWithRetry();
      if (!stopError && this.processManager === manager) this.processManager = undefined;
      if (stopError) throw stopError;
    })();
    this.transportResetPromise = reset;
    try {
      await reset;
    } finally {
      if (this.transportResetPromise === reset) this.transportResetPromise = undefined;
    }
  }

  private async cleanupLaunch(): Promise<void> {
    const ownerId = this.launchCleanupOwnerId;
    if (!ownerId) return;
    await acpLaunchCleanupRegistry.runWithImmediateRetries(ownerId);
    // Successful owners are removed from the registry. Keep failed owner IDs
    // attached so a later close/reset can retry the same callback.
    if (!acpLaunchCleanupRegistry.getState(ownerId)) {
      this.launchCleanupOwnerId = undefined;
    }
  }

  private async cleanupLaunchWithRetry(): Promise<void> {
    try {
      await this.cleanupLaunch();
    } catch (error) {
      console.warn('[AcpRuntimeDriver] Auxiliary launch cleanup scheduled for retry', error);
    }
  }

  private async ensureAgentSession(turn: RuntimeRunTurnInput, sink: RuntimeDriverEventSink): Promise<void> {
    if (this.sessionReady) return;
    const connection = this.connection;
    if (!connection) throw new AgentRuntimeError('connection_closed', 'session', 'ACP connection is closed', true);
    const requestedExternalId = turn.resumeExternalSessionId ?? this.currentExternalSessionId;
    const mcpServers = buildAcpMcpServers(this.input.env);
    const sessionMetadata = this.definition.sessionMetadata?.(this.providerProfile) ?? {};
    const bootstrapUpdates: SessionNotification[] = [];
    this.sessionBootstrapUpdates = bootstrapUpdates;
    const resumeMode = turn.resumeMode ?? 'load';
    const shouldResumeWithoutHistory = Boolean(requestedExternalId)
      && resumeMode === 'resume'
      && this.supportsSessionResume;
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
        this.currentExternalSessionId = requestedExternalId;
        await this.definition.configureSession?.(
          connection.agent,
          requestedExternalId,
          response,
          this.providerProfile,
        );
      } else {
        const response = await connection.agent.request(acp.methods.agent.session.new, {
          cwd: this.input.workingDir,
          mcpServers,
          ...sessionMetadata,
        });
        this.currentExternalSessionId = response.sessionId;
        await this.definition.configureSession?.(
          connection.agent,
          response.sessionId,
          response,
          this.providerProfile,
        );
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      if (this.sessionBootstrapUpdates === bootstrapUpdates) {
        this.sessionBootstrapUpdates = undefined;
      }
    }
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

    const mergedEntries = reconcileAcpHistoryEntries(
      turn.msgStore.getSnapshot().entries,
      replayStore.getSnapshot().entries,
      { historyBoundaryEntryId: turn.historyBoundaryEntryId },
    );
    if (!mergedEntries) return;

    const patch: JsonPatch = [{ op: 'replace', path: '/entries', value: mergedEntries }];
    turn.msgStore.entryIndex.startFrom(mergedEntries.length);
    const seq = turn.msgStore.pushPatch(patch);
    sink.stream({ type: 'conversation_patch', patch, seq });
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
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)} [TRUNCATED]` : redacted;
}

function normalizePermissionKind(value: string): RuntimePermissionOption['kind'] {
  if (value === 'allow_once' || value === 'allow_always' || value === 'reject_once' || value === 'reject_always') {
    return value;
  }
  return 'unknown' as const;
}
