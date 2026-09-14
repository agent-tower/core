import { AgentType, RuntimeType } from '@agent-tower/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionEnv } from '../../executors/execution-env.js';
import { MsgStore, type NormalizedEntry } from '../../output/index.js';
import type { RuntimeDriverEventSink } from '../contracts.js';
import { AgentRuntimeError } from '../errors.js';
import { WorkspaceBackgroundProcessManager } from '../../services/workspace-background-process-manager.js';
import { RuntimeCoordinator } from '../runtime-coordinator.js';
import { StaticRuntimeRegistry } from '../runtime-registry.js';
import * as acpRegistry from '../acp/agents/registry.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Detects a UTF-16 code unit kept without its surrogate-pair counterpart.
 * Bounded diagnostics used to be sliced straight at the cut point, which
 * persisted half an emoji (rendered as U+FFFD) instead of a whole character.
 */
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const acpState = vi.hoisted(() => ({
  authMethods: [{ id: 'api-key', name: 'API Key' }] as Array<{ id: string; name: string }>,
  loadUpdates: [] as Array<{ sessionId: string; update: Record<string, unknown> }>,
  supportsResume: true,
  notificationHandler: undefined as undefined | ((request: { params: unknown }) => Promise<void>),
  permissionHandler: undefined as undefined | ((request: {
    params: Record<string, unknown>;
    signal: AbortSignal;
  }) => Promise<unknown>),
  notificationHandlers: [] as Array<(request: { params: unknown }) => Promise<void>>,
  permissionHandlers: [] as Array<(request: {
    params: Record<string, unknown>;
    signal: AbortSignal;
  }) => Promise<unknown>>,
  loadRequestGate: undefined as Promise<void> | undefined,
  loadRequestEntered: undefined as (() => void) | undefined,
  prompt: undefined as undefined | {
    promise: Promise<{ stopReason?: string }>;
    resolve: (value: { stopReason?: string }) => void;
    reject: (error: unknown) => void;
  },
  request: undefined as unknown as ReturnType<typeof vi.fn>,
  notify: undefined as unknown as ReturnType<typeof vi.fn>,
  close: undefined as unknown as ReturnType<typeof vi.fn>,
  processStarts: 0,
  processStops: 0,
  processStopErrors: [] as unknown[],
  processStopGate: undefined as undefined | Promise<void>,
  processExitListeners: [] as Array<(exit: {
    exitCode: number | null;
    signal: string | null;
    stderrExcerpt: string;
  }) => void>,
  initializeError: undefined as unknown,
}));

const providerState = vi.hoisted(() => ({
  provider: null as null | {
    id: string;
    name: string;
    agentType: string;
    runtimeType: string;
    env: Record<string, string>;
    config: Record<string, unknown>;
    isDefault: boolean;
  },
}));

vi.mock('../../executors/providers.js', () => ({
  getProviderById: vi.fn(() => providerState.provider),
  getProviderRuntimeType: vi.fn((provider: { runtimeType?: string }) => provider.runtimeType ?? 'CLI'),
}));

vi.mock('@agentclientprotocol/sdk', () => {
  const methods = {
    agent: {
      authenticate: 'authenticate',
      initialize: 'initialize',
      session: {
        cancel: 'session/cancel',
        load: 'session/load',
        new: 'session/new',
        prompt: 'session/prompt',
        resume: 'session/resume',
        setConfigOption: 'session/set_config_option',
        setMode: 'session/set_mode',
      },
    },
    client: {
      session: {
        requestPermission: 'session/request_permission',
        update: 'session/update',
      },
    },
  };
  acpState.request = vi.fn(async (method: string) => {
    if (method === methods.agent.initialize) {
      if (acpState.initializeError) throw acpState.initializeError;
      return {
        protocolVersion: 1,
        authMethods: acpState.authMethods,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: acpState.supportsResume ? { resume: {} } : {},
        },
      };
    }
    if (method === methods.agent.session.load) {
      acpState.loadRequestEntered?.();
      await acpState.loadRequestGate;
      for (const params of acpState.loadUpdates) {
        await acpState.notificationHandler?.({ params });
      }
      return {};
    }
    if (method === methods.agent.session.new) return { sessionId: 'external-new' };
    if (method === methods.agent.session.prompt) return acpState.prompt?.promise;
    return {};
  });
  acpState.notify = vi.fn(async (method: string) => {
    if (method === methods.agent.session.cancel) {
      acpState.prompt?.reject(new Error('ACP connection closed'));
    }
  });
  acpState.close = vi.fn();
  const app = {
    onNotification: vi.fn((_method: string, handler: typeof acpState.notificationHandler) => {
      acpState.notificationHandler = handler;
      if (handler) acpState.notificationHandlers.push(handler);
      return app;
    }),
    onRequest: vi.fn((_method: string, handler: typeof acpState.permissionHandler) => {
      acpState.permissionHandler = handler;
      if (handler) acpState.permissionHandlers.push(handler);
      return app;
    }),
    connect: vi.fn(() => ({
      agent: { request: acpState.request, notify: acpState.notify },
      close: acpState.close,
      closed: new Promise<void>(() => undefined),
    })),
  };
  return {
    PROTOCOL_VERSION: 1,
    methods,
    client: vi.fn(() => app),
    ndJsonStream: vi.fn(() => ({})),
  };
});

vi.mock('../acp/process-manager.js', () => ({
  AcpProcessManager: class {
    async start() {
      acpState.processStarts += 1;
      return { pid: 123, input: {}, output: {} };
    }
    onExit(listener: (exit: {
      exitCode: number | null;
      signal: string | null;
      stderrExcerpt: string;
    }) => void) {
      acpState.processExitListeners.push(listener);
    }
    async stop() {
      acpState.processStops += 1;
      await acpState.processStopGate;
      const error = acpState.processStopErrors.shift();
      if (error) throw error;
    }
  },
}));

vi.mock('../../utils/error-log.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../utils/error-log.js')>(),
  writeErrorLog: vi.fn(),
}));

import { AcpRuntimeDriver } from '../acp/acp-driver.js';
import { writeErrorLog } from '../../utils/error-log.js';

function setup() {
  const sink: RuntimeDriverEventSink = {
    stream: vi.fn(),
    process: vi.fn(async () => undefined),
  };
  const input = {
    towerSessionId: 'tower-1',
    agentType: AgentType.CODEX,
    runtimeType: RuntimeType.ACP,
    variant: 'DEFAULT',
    workingDir: process.cwd(),
    env: ExecutionEnv.default(process.cwd())
      .set('CODEX_PATH', process.execPath)
      .set('AGENT_TOWER_URL', 'http://127.0.0.1:1')
      .set('AGENT_TOWER_AGENT_CREDENTIAL', 'lifecycle-test-credential'),
    externalSessionId: 'external-1',
  };
  return { sink, input };
}

beforeEach(() => {
  vi.clearAllMocks();
  acpState.authMethods = [{ id: 'api-key', name: 'API Key' }];
  acpState.loadUpdates = [];
  acpState.supportsResume = true;
  acpState.notificationHandler = undefined;
  acpState.permissionHandler = undefined;
  acpState.notificationHandlers.length = 0;
  acpState.permissionHandlers.length = 0;
  acpState.loadRequestGate = undefined;
  acpState.loadRequestEntered = undefined;
  acpState.prompt = deferred<{ stopReason?: string }>();
  acpState.processStarts = 0;
  acpState.processStops = 0;
  acpState.processStopErrors = [];
  acpState.processStopGate = undefined;
  acpState.processExitListeners.length = 0;
  acpState.initializeError = undefined;
  providerState.provider = null;
});

describe('AcpRuntimeDriver lifecycle', () => {
  function installLaunchCleanup(cleanup: () => Promise<void>) {
    const definition = acpRegistry.getAcpAgentDefinition(AgentType.CODEX);
    return vi.spyOn(acpRegistry, 'getAcpAgentDefinition').mockReturnValue({
      ...definition,
      resolveLaunch: async (input, profile) => {
        const launch = await definition.resolveLaunch(input, profile);
        return { ...launch, cleanup };
      },
    });
  }

  it('uses non-persistent permission approval as the unrestricted fallback', async () => {
    providerState.provider = {
      id: 'opencode-acp-unrestricted',
      name: 'OpenCode ACP Unrestricted',
      agentType: AgentType.OPENCODE,
      runtimeType: RuntimeType.ACP,
      env: { OPENCODE_PATH: process.execPath },
      config: { permissionMode: 'UNRESTRICTED' },
      isDefault: false,
    };
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open({
      ...input,
      agentType: AgentType.OPENCODE,
      providerId: providerState.provider.id,
      env: input.env.set('OPENCODE_PATH', process.execPath),
    }, sink);
    const turn = await session.runTurn({
      turnId: 'turn-unrestricted',
      prompt: 'run a tool',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);

    const response = await acpState.permissionHandler?.({
      params: {
        sessionId: 'external-1',
        options: [
          { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        ],
        toolCall: { toolCallId: 'tool-1', title: 'Run command', kind: 'execute' },
      },
      signal: new AbortController().signal,
    });

    expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
    expect(vi.mocked(sink.stream).mock.calls.map(([event]) => event.type)).not.toContain('permission_requested');

    await session.cancelTurn('turn-unrestricted');
    await turn.completion;
    await session.close();
  });

  it('merges Codex gateway auth capability with the shared session capability', async () => {
    acpState.authMethods = [{ id: 'gateway', name: 'Custom model gateway' }];
    providerState.provider = {
      id: 'codex-acp-gateway',
      name: 'Codex ACP Gateway',
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.ACP,
      env: {
        OPENAI_API_KEY: 'gateway-provider-secret',
        OPENAI_BASE_URL: 'https://gateway.example/v1',
      },
      config: {},
      isDefault: false,
    };
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open({
      ...input,
      providerId: providerState.provider.id,
      externalSessionId: undefined,
    }, sink);

    expect(acpState.request).toHaveBeenNthCalledWith(1, 'initialize', expect.objectContaining({
      clientCapabilities: {
        auth: { _meta: { gateway: true } },
        session: { configOptions: { boolean: {} } },
      },
    }));
    expect(acpState.request).toHaveBeenNthCalledWith(2, 'authenticate', expect.objectContaining({
      methodId: 'gateway',
      _meta: {
        gateway: expect.objectContaining({
          baseUrl: 'https://gateway.example/v1',
          headers: expect.objectContaining({ Authorization: 'Bearer gateway-provider-secret' }),
        }),
      },
    }));

    await session.close();
  });

  it('authenticates after initialize and before creating the first session', async () => {
    providerState.provider = {
      id: 'codex-acp-auth',
      name: 'Codex ACP Auth',
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.ACP,
      env: { OPENAI_API_KEY: 'lifecycle-provider-secret' },
      config: {},
      isDefault: false,
    };
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open({
      ...input,
      providerId: providerState.provider.id,
      externalSessionId: undefined,
    }, sink);
    const turn = await session.runTurn({
      turnId: 'turn-auth',
      prompt: 'start authenticated session',
      msgStore: new MsgStore(),
    }, sink);

    const methods = vi.mocked(acpState.request).mock.calls.map(([method]) => method);
    expect(methods.slice(0, 4)).toEqual([
      'initialize',
      'authenticate',
      'session/new',
      'session/prompt',
    ]);
    expect(acpState.request).toHaveBeenCalledWith('authenticate', { methodId: 'api-key' });

    await session.cancelTurn('turn-auth');
    await turn.completion;
    await session.close();
  });

  it('does not send a prompt when admission is cancelled in the ready-session microtask window', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const first = await session.runTurn({
      turnId: 'turn-ready',
      prompt: 'prepare the reusable session',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);
    acpState.prompt?.resolve({ stopReason: 'end_turn' });
    await first.completion;

    const promptCallsBefore = vi.mocked(acpState.request).mock.calls
      .filter(([method]) => method === 'session/prompt').length;
    const streamCallsBefore = vi.mocked(sink.stream).mock.calls.length;
    const controller = new AbortController();
    queueMicrotask(() => controller.abort(new AgentRuntimeError(
      'runtime_admission_cancelled',
      'prompt',
      'disposal won before prompt',
      true,
    )));
    const nextStore = new MsgStore();

    await expect(session.runTurn({
      turnId: 'turn-aborted-before-prompt',
      prompt: 'must never be sent',
      msgStore: nextStore,
      resumeExternalSessionId: 'external-1',
      admissionSignal: controller.signal,
    }, sink)).rejects.toMatchObject({
      code: 'runtime_admission_cancelled',
      retryable: true,
    });

    expect(vi.mocked(acpState.request).mock.calls
      .filter(([method]) => method === 'session/prompt')).toHaveLength(promptCallsBefore);
    expect(vi.mocked(sink.stream).mock.calls).toHaveLength(streamCallsBefore);
    expect(nextStore.getSnapshot().entries).toEqual([]);
    await session.close();
  });

  it('does not stop a real workspace service when the ACP driver is disposed', async () => {
    const backgroundManager = new WorkspaceBackgroundProcessManager({
      resolveCommand: async () => process.execPath,
    });
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    let started: Awaited<ReturnType<typeof backgroundManager.start>> | null = null;

    try {
      started = await backgroundManager.start('service-acp', 'runtime-acp', {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
      }, vi.fn());
      await session.close();

      expect(acpState.close).toHaveBeenCalledOnce();
      expect(backgroundManager.has('service-acp', started.runtimeInstanceId)).toBe(true);
    } finally {
      await session.close();
      await backgroundManager.stopAll().catch(() => undefined);
    }
  }, 15_000);

  it('retries ACP transport cleanup after the first process-tree stop fails', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    acpState.processStopErrors.push(new Error('tree still alive'));

    await expect(session.close()).rejects.toThrow('tree still alive');
    expect(vi.mocked(sink.process).mock.calls.filter(([event]) => (
      event.type === 'tree_cleanup_completed'
    ))).toHaveLength(0);
    await expect(session.close()).resolves.toBeUndefined();
    expect(acpState.processStops).toBe(2);
    expect(vi.mocked(sink.process).mock.calls.filter(([event]) => (
      event.type === 'tree_cleanup_completed'
    ))).toHaveLength(1);
  });

  it('confirms cleanup evidence for every successfully reset ACP transport generation', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const firstRuntimeInstanceId = session.runtimeInstanceId;

    await (session as unknown as { resetTransport(): Promise<void> }).resetTransport();
    await (session as unknown as {
      connect(sink: RuntimeDriverEventSink, claim: number, signal?: AbortSignal): Promise<void>;
    }).connect(sink, 2);
    const secondRuntimeInstanceId = session.runtimeInstanceId;
    await session.close();

    const cleanupEvents = vi.mocked(sink.process).mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'tree_cleanup_completed');
    expect(cleanupEvents).toEqual([
      {
        type: 'tree_cleanup_completed',
        runtimeInstanceId: firstRuntimeInstanceId,
        launchClaimNumber: 1,
      },
      {
        type: 'tree_cleanup_completed',
        runtimeInstanceId: secondRuntimeInstanceId,
        launchClaimNumber: 2,
      },
    ]);
  });

  it('drops stale transport updates and permissions after a new generation is active', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const firstNotification = acpState.notificationHandlers[0]!;
    const firstPermission = acpState.permissionHandlers[0]!;
    const first = await session.runTurn({
      turnId: 'turn-old-generation',
      prompt: 'first generation',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);
    acpState.prompt?.resolve({ stopReason: 'end_turn' });
    await first.completion;

    await (session as unknown as { resetTransport(): Promise<void> }).resetTransport();
    await (session as unknown as {
      connect(sink: RuntimeDriverEventSink, claim: number, signal?: AbortSignal): Promise<void>;
    }).connect(sink, 2);
    const currentNotification = acpState.notificationHandlers[1]!;
    const currentPermission = acpState.permissionHandlers[1]!;
    acpState.prompt = deferred<{ stopReason?: string }>();
    const currentStore = new MsgStore();
    const loadEntered = deferred<void>();
    const releaseLoad = deferred<void>();
    acpState.loadRequestEntered = () => loadEntered.resolve();
    acpState.loadRequestGate = releaseLoad.promise;
    const currentStart = session.runTurn({
      turnId: 'turn-current-generation',
      prompt: 'second generation',
      msgStore: currentStore,
      resumeExternalSessionId: 'external-1',
    }, sink);
    await loadEntered.promise;
    const streamCallsBeforeStaleHandlers = vi.mocked(sink.stream).mock.calls.length;

    await firstNotification({
      params: {
        sessionId: 'external-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'stale-message',
          content: { type: 'text', text: 'stale transport output' },
        },
      },
    });
    await expect(firstPermission({
      params: {
        sessionId: 'external-1',
        options: [{ optionId: 'stale-allow', name: 'Allow', kind: 'allow_once' }],
        toolCall: { toolCallId: 'stale-tool', title: 'Stale tool', kind: 'execute' },
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });

    expect(vi.mocked(sink.stream).mock.calls).toHaveLength(streamCallsBeforeStaleHandlers);
    expect(currentStore.getSnapshot().entries).toEqual([]);

    releaseLoad.resolve();
    const current = await currentStart;
    expect(currentStore.getSnapshot().entries).toEqual([]);

    await currentNotification({
      params: {
        sessionId: 'external-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'current-message',
          content: { type: 'text', text: 'current transport output' },
        },
      },
    });
    const permissionAbort = new AbortController();
    const currentPermissionResponse = currentPermission({
      params: {
        sessionId: 'external-1',
        options: [{ optionId: 'current-allow', name: 'Allow', kind: 'allow_once' }],
        toolCall: { toolCallId: 'current-tool', title: 'Current tool', kind: 'execute' },
      },
      signal: permissionAbort.signal,
    });

    expect(currentStore.getSnapshot().entries.map((entry) => entry.content)).toEqual([
      'current transport output',
    ]);
    expect(vi.mocked(sink.stream).mock.calls.map(([event]) => event.type))
      .toContain('permission_requested');
    permissionAbort.abort();
    await expect(currentPermissionResponse).resolves.toEqual({ outcome: { outcome: 'cancelled' } });

    acpState.prompt.resolve({ stopReason: 'end_turn' });
    await current.completion;
    await session.close();
  });

  it('retains a stopped transport until its cleanup evidence can be persisted', async () => {
    const { sink, input } = setup();
    let cleanupAttempts = 0;
    vi.mocked(sink.process).mockImplementation(async (event) => {
      if (event.type === 'tree_cleanup_completed' && cleanupAttempts++ === 0) {
        throw new Error('cleanup evidence unavailable');
      }
    });
    const session = await new AcpRuntimeDriver().open(input, sink);

    await expect(session.close()).rejects.toThrow('cleanup evidence unavailable');
    await expect(session.close()).resolves.toBeUndefined();

    expect(acpState.processStops).toBe(2);
    expect(vi.mocked(sink.process).mock.calls.filter(([event]) => (
      event.type === 'tree_cleanup_completed'
    ))).toHaveLength(2);
  });

  it('retries auxiliary launch cleanup during a normal DriverSession close', async () => {
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error('managed directory busy'))
      .mockResolvedValueOnce(undefined);
    const definitionSpy = installLaunchCleanup(cleanup);
    const { sink, input } = setup();

    try {
      const session = await new AcpRuntimeDriver().open(input, sink);
      await expect(session.close()).resolves.toBeUndefined();
      expect(cleanup).toHaveBeenCalledTimes(2);
    } finally {
      definitionSpy.mockRestore();
    }
  });

  it('retries auxiliary launch cleanup before coordinator disposal releases the DriverSession', async () => {
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error('managed directory busy'))
      .mockResolvedValueOnce(undefined);
    const definitionSpy = installLaunchCleanup(cleanup);
    const { input } = setup();
    const coordinator = new RuntimeCoordinator(
      new StaticRuntimeRegistry([new AcpRuntimeDriver()]),
      {
        onTurnEvent: vi.fn(),
        onRuntimeState: vi.fn(),
        onProcessEvent: vi.fn(async () => undefined),
      },
    );

    try {
      await coordinator.startTurn({
        ...input,
        msgStore: new MsgStore(),
        prompt: 'managed cleanup',
      });
      await expect(coordinator.disposeSession(input.towerSessionId)).resolves.toBeUndefined();
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(coordinator.getState(input.towerSessionId).turnState).toBe('IDLE');
    } finally {
      definitionSpy.mockRestore();
      await coordinator.destroyAll();
    }
  });

  it('retries auxiliary launch cleanup when ACP initialization fails', async () => {
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error('managed directory busy'))
      .mockResolvedValueOnce(undefined);
    const definitionSpy = installLaunchCleanup(cleanup);
    acpState.initializeError = new Error('initialize failed');
    const { sink, input } = setup();

    try {
      await expect(new AcpRuntimeDriver().open(input, sink)).rejects.toThrow('initialize failed');
      expect(cleanup).toHaveBeenCalledTimes(2);
    } finally {
      definitionSpy.mockRestore();
    }
  });

  it('does not spawn a reconnect after close begins while transport reset is pending', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const resetRelease = deferred<void>();
    acpState.processStopGate = resetRelease.promise;

    const reset = (session as unknown as {
      resetTransport(): Promise<void>;
    }).resetTransport();
    await vi.waitFor(() => expect(acpState.processStops).toBe(1));
    const reconnect = (session as unknown as {
      connect(sink: RuntimeDriverEventSink, claim: number, signal?: AbortSignal): Promise<void>;
    }).connect(sink, 2);
    const closing = session.close();

    resetRelease.resolve();
    await reset;
    await closing;
    await expect(reconnect).rejects.toMatchObject({ code: 'connection_closed' });
    expect(acpState.processStarts).toBe(1);
    expect(acpState.processStops).toBe(1);
  });

  it('cleans a late resolveLaunch result without spawning after close', async () => {
    const resolveLaunchEntered = deferred<void>();
    const resolveLaunchRelease = deferred<void>();
    const cleanup = vi.fn(async () => undefined);
    const definition = acpRegistry.getAcpAgentDefinition(AgentType.CODEX);
    let launchCount = 0;
    const definitionSpy = vi.spyOn(acpRegistry, 'getAcpAgentDefinition').mockReturnValue({
      ...definition,
      resolveLaunch: async (launchInput, profile) => {
        launchCount += 1;
        if (launchCount === 2) {
          resolveLaunchEntered.resolve();
          await resolveLaunchRelease.promise;
        }
        const launch = await definition.resolveLaunch(launchInput, profile);
        return { ...launch, cleanup };
      },
    });
    const { sink, input } = setup();

    try {
      const session = await new AcpRuntimeDriver().open(input, sink);
      await (session as unknown as { resetTransport(): Promise<void> }).resetTransport();
      expect(acpState.processStarts).toBe(1);

      const reconnect = (session as unknown as {
        connect(sink: RuntimeDriverEventSink, claim: number, signal?: AbortSignal): Promise<void>;
      }).connect(sink, 2);
      await resolveLaunchEntered.promise;
      await session.close();
      resolveLaunchRelease.resolve();

      await expect(reconnect).rejects.toMatchObject({ code: 'connection_closed' });
      expect(acpState.processStarts).toBe(1);
      expect(acpState.processStops).toBe(1);
      expect(cleanup).toHaveBeenCalledTimes(2);
    } finally {
      resolveLaunchRelease.resolve();
      definitionSpy.mockRestore();
    }
  });

  it('reconciles session/load history with one entries patch', async () => {
    const { sink, input } = setup();
    const stableMessageId = `acp-message-${Buffer.from('message-1').toString('base64url')}`;
    const localEntries: NormalizedEntry[] = [
      { id: 'local-user', timestamp: 1, entryType: 'user_message', content: 'continue' },
      { id: stableMessageId, timestamp: 2, entryType: 'assistant_message', content: 'part' },
    ];
    acpState.loadUpdates = [{
      sessionId: 'external-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-1',
        content: { type: 'text', text: 'partial response completed' },
      },
    }];
    const msgStore = new MsgStore();
    msgStore.restoreFromSnapshot({ sessionId: 'external-1', entries: localEntries, seq: 4 });
    const session = await new AcpRuntimeDriver().open(input, sink);

    const turn = await session.runTurn({
      turnId: 'turn-1',
      prompt: 'continue',
      msgStore,
      resumeExternalSessionId: 'external-1',
    }, sink);

    const patches = vi.mocked(sink.stream).mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'conversation_patch');
    expect(patches).toHaveLength(2);
    expect(patches[1]).toMatchObject({
      patch: [{ op: 'replace', path: '/entries' }],
    });
    expect(msgStore.getSnapshot().entries).toEqual([
      localEntries[0],
      { ...localEntries[1], content: 'partial response completed' },
    ]);

    await session.cancelTurn('turn-1');
    await turn.completion;
    await session.close();
  });

  it('does not replay Codex history when load changes the message ID', async () => {
    const { sink, input } = setup();
    const localEntries: NormalizedEntry[] = [
      {
        id: `acp-message-${Buffer.from('msg-live').toString('base64url')}`,
        timestamp: 1,
        entryType: 'assistant_message',
        content: 'already persisted response',
      },
      { id: 'current-user', timestamp: 2, entryType: 'user_message', content: 'continue' },
    ];
    acpState.loadUpdates = [{
      sessionId: 'external-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'item-1',
        content: { type: 'text', text: 'already persisted response' },
      },
    }];
    const msgStore = new MsgStore();
    msgStore.restoreFromSnapshot({ sessionId: 'external-1', entries: localEntries, seq: 4 });
    const session = await new AcpRuntimeDriver().open(input, sink);

    const turn = await session.runTurn({
      turnId: 'turn-id-drift',
      prompt: 'continue',
      msgStore,
      resumeExternalSessionId: 'external-1',
      historyBoundaryEntryId: 'current-user',
    }, sink);

    const patches = vi.mocked(sink.stream).mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'conversation_patch');
    expect(patches).toHaveLength(1);
    expect(msgStore.getSnapshot().entries).toEqual(localEntries);

    await session.cancelTurn('turn-id-drift');
    await turn.completion;
    await session.close();
  });

  it('uses session/resume for a context-only follow-up', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const msgStore = new MsgStore();

    const turn = await session.runTurn({
      turnId: 'turn-resume',
      prompt: 'continue in a new Tower session',
      msgStore,
      resumeExternalSessionId: 'external-1',
      resumeMode: 'resume',
    }, sink);

    const methods = vi.mocked(acpState.request).mock.calls.map(([method]) => method);
    expect(methods).toContain('session/resume');
    expect(methods).not.toContain('session/load');
    expect(msgStore.getSnapshot().entries).toEqual([]);

    await session.cancelTurn('turn-resume');
    await turn.completion;
    await session.close();
  });

  it('falls back to session/load without importing history when resume is unsupported', async () => {
    acpState.supportsResume = false;
    acpState.loadUpdates = [{
      sessionId: 'external-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'old-message',
        content: { type: 'text', text: 'old response' },
      },
    }];
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const msgStore = new MsgStore();

    const turn = await session.runTurn({
      turnId: 'turn-fallback',
      prompt: 'continue with a legacy agent',
      msgStore,
      resumeExternalSessionId: 'external-1',
      resumeMode: 'resume',
    }, sink);

    const methods = vi.mocked(acpState.request).mock.calls.map(([method]) => method);
    expect(methods).toContain('session/load');
    expect(methods).not.toContain('session/resume');
    expect(msgStore.getSnapshot().entries).toEqual([]);

    await session.cancelTurn('turn-fallback');
    await turn.completion;
    await session.close();
  });

  it('treats an expected cancel rejection as cancelled and reuses the connection', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const firstStore = new MsgStore();
    const first = await session.runTurn({
      turnId: 'turn-1',
      prompt: 'first',
      msgStore: firstStore,
      resumeExternalSessionId: 'external-1',
    }, sink);

    await session.cancelTurn('turn-1');
    await expect(first.completion).resolves.toEqual({ stopReason: 'cancelled' });
    expect(firstStore.getSnapshot().entries).toEqual([]);
    expect(acpState.close).not.toHaveBeenCalled();

    acpState.prompt = deferred<{ stopReason?: string }>();
    const second = await session.runTurn({
      turnId: 'turn-2',
      prompt: 'second',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);
    acpState.prompt.resolve({ stopReason: 'end_turn' });
    await expect(second.completion).resolves.toEqual({ stopReason: 'end_turn' });

    const methods = vi.mocked(acpState.request).mock.calls.map(([method]) => method);
    expect(methods.filter((method) => method === 'session/load')).toHaveLength(1);
    expect(methods.filter((method) => method === 'session/prompt')).toHaveLength(2);
    await session.close();
  });

  it('restarts a poisoned ACP transport and loads the external session on follow-up', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const first = await session.runTurn({
      turnId: 'turn-failed',
      prompt: 'produce a large tool result',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);

    acpState.prompt?.reject(new AgentRuntimeError(
      'protocol_violation',
      'protocol',
      'ACP stdout line exceeded the size limit',
      false,
    ));
    await expect(first.completion).rejects.toMatchObject({ code: 'protocol_violation' });
    expect(acpState.processStarts).toBe(1);
    expect(acpState.processStops).toBe(1);

    acpState.prompt = deferred<{ stopReason?: string }>();
    const second = await session.runTurn({
      turnId: 'turn-reconnected',
      prompt: 'continue',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);
    acpState.prompt.resolve({ stopReason: 'end_turn' });
    await expect(second.completion).resolves.toEqual({ stopReason: 'end_turn' });

    const methods = vi.mocked(acpState.request).mock.calls.map(([method]) => method);
    expect(acpState.processStarts).toBe(2);
    expect(methods.filter((method) => method === 'initialize')).toHaveLength(2);
    expect(methods.filter((method) => method === 'session/load')).toHaveLength(2);
    await session.close();
    expect(acpState.processStops).toBe(2);
  });

  it('surfaces the adapter exit reason when the ACP process dies mid-turn', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const msgStore = new MsgStore();
    const turn = await session.runTurn({
      turnId: 'turn-process-exit',
      prompt: 'run the heavy test suite',
      msgStore,
      resumeExternalSessionId: 'external-1',
    }, sink);

    // The adapter dies on its own; the SDK then closes the transport first, so
    // without the recorded exit facts the turn only reports the generic error.
    acpState.processExitListeners.at(-1)?.({
      exitCode: 1,
      signal: null,
      stderrExcerpt: 'Fatal: unhandled rejection in the adapter',
    });
    acpState.prompt?.reject(new Error('ACP connection closed'));

    await expect(turn.completion).rejects.toMatchObject({
      code: 'process_exit',
      retryable: true,
      message: expect.stringContaining('Fatal: unhandled rejection in the adapter'),
    });
    expect(msgStore.getSnapshot().entries.map((entry) => entry.content))
      .toEqual([expect.stringContaining('Fatal: unhandled rejection in the adapter')]);
    expect(vi.mocked(writeErrorLog)).toHaveBeenCalledWith(expect.objectContaining({
      level: 'error',
      source: 'session.acp.processExit',
      metadata: expect.objectContaining({
        towerSessionId: 'tower-1',
        exitCode: 1,
        signal: null,
        stderrChars: 'Fatal: unhandled rejection in the adapter'.length,
        stderrSummary: 'Fatal: unhandled rejection in the adapter',
      }),
    }));

    await session.close();
  });

  it('persists a bounded, redacted stderr summary instead of the raw adapter output', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const turn = await session.runTurn({
      turnId: 'turn-stderr-summary',
      prompt: 'run the heavy test suite',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);

    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz';
    // Long enough that both the per-excerpt bound and the line-count tail slice
    // have to drop content. The sensitive dump and the root cause sit in the
    // kept tail, so the assertions below exercise redaction, not just slicing.
    const noise = Array.from(
      { length: 40 },
      (_, index) => `debug line ${index} without the root cause ${'x'.repeat(160)}`,
    ).join('\n');
    acpState.processExitListeners.at(-1)?.({
      exitCode: 1,
      signal: null,
      stderrExcerpt: [
        noise,
        'Environment dump:',
        'HOME=/Users/jane.doe',
        `OPENAI_API_KEY=${secret}`,
        'CONTACT=jane.doe@example.com',
        'Operator: jane.doe@example.com',
        'Fatal: adapter crashed while writing /Users/jane.doe/private/session.json',
      ].join('\n'),
    });
    acpState.prompt?.reject(new Error('ACP connection closed'));

    const entry = vi.mocked(writeErrorLog).mock.calls.at(-1)?.[0];
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('jane.doe');
    expect(serialized).not.toContain('debug line 0 without the root cause');
    expect(serialized).toContain('HOME=[REDACTED]');
    expect(serialized).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(serialized).toContain('Operator: [EMAIL]');
    expect(serialized).toContain('Fatal: adapter crashed while writing ~/private/session.json');

    const metadata = entry?.metadata as { stderrChars: number; stderrSummary: string };
    expect(metadata.stderrChars).toBeGreaterThan(6_000);
    expect(metadata.stderrSummary).toContain('Fatal: adapter crashed');
    expect(metadata.stderrSummary).toContain('chars omitted');
    expect(metadata.stderrSummary.length).toBeLessThanOrEqual(1_200);

    await expect(turn.completion).rejects.toMatchObject({
      code: 'process_exit',
      message: expect.stringContaining('Fatal: adapter crashed while writing ~/private/session.json'),
    });

    await session.close();
  });

  it('keeps surrogate pairs whole when bounding a stderr line (300 code units)', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const turn = await session.runTurn({
      turnId: 'turn-surrogate-line',
      prompt: 'run the heavy test suite',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);

    // The per-line bound is 300 code units: the head cut ends at index 100 and
    // the tail cut starts 152 units before the end. Each line puts an emoji on
    // one of those cuts, so a straight UTF-16 slice keeps half of it.
    const headSplitLine = `${'a'.repeat(99)}😀${'b'.repeat(400)}`;
    const tailSplitLine = `${'b'.repeat(348)}😀${'c'.repeat(151)}`;
    expect(hasUnpairedSurrogate(headSplitLine.slice(0, 100))).toBe(true);
    expect(hasUnpairedSurrogate(tailSplitLine.slice(349))).toBe(true);

    acpState.processExitListeners.at(-1)?.({
      exitCode: 1,
      signal: null,
      stderrExcerpt: [headSplitLine, tailSplitLine].join('\n'),
    });
    acpState.prompt?.reject(new Error('ACP connection closed'));

    const metadata = vi.mocked(writeErrorLog).mock.calls.at(-1)?.[0]?.metadata as
      | { stderrSummary: string }
      | undefined;
    const summary = metadata?.stderrSummary ?? '';
    expect(summary).toContain('chars omitted');
    expect(summary.length).toBeLessThanOrEqual(1_200);
    expect(hasUnpairedSurrogate(summary)).toBe(false);

    await expect(turn.completion).rejects.toMatchObject({ code: 'process_exit' });
    await session.close();
  });

  it('keeps surrogate pairs whole when the stderr summary bound kicks in (1_200 code units)', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const turn = await session.runTurn({
      turnId: 'turn-surrogate-summary',
      prompt: 'run the heavy test suite',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);

    // Seven 200-unit lines stay under the per-line bound, so only the 1_200-unit
    // summary bound runs: its head cut ends at index 400 and its tail cut starts
    // 752 units before the end, inside an emoji on both ends.
    const line = `xy${'😀'.repeat(99)}`;
    const excerpt = Array.from({ length: 7 }, () => line).join('\n');
    expect(excerpt.length).toBe(1_406);
    expect(hasUnpairedSurrogate(excerpt.slice(0, 400))).toBe(true);
    expect(hasUnpairedSurrogate(excerpt.slice(excerpt.length - 752))).toBe(true);

    acpState.processExitListeners.at(-1)?.({ exitCode: 1, signal: null, stderrExcerpt: excerpt });
    acpState.prompt?.reject(new Error('ACP connection closed'));

    const metadata = vi.mocked(writeErrorLog).mock.calls.at(-1)?.[0]?.metadata as
      | { stderrSummary: string }
      | undefined;
    const summary = metadata?.stderrSummary ?? '';
    expect(summary).toContain('chars omitted');
    expect(summary.length).toBeLessThanOrEqual(1_200);
    expect(hasUnpairedSurrogate(summary)).toBe(false);

    await expect(turn.completion).rejects.toMatchObject({ code: 'process_exit' });
    await session.close();
  });

  it('keeps surrogate pairs whole when bounding the session failure message (4_096 code units)', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const msgStore = new MsgStore();
    const turn = await session.runTurn({
      turnId: 'turn-surrogate-failure',
      prompt: 'run the heavy test suite',
      msgStore,
      resumeExternalSessionId: 'external-1',
    }, sink);

    // The 4_096-unit bound cuts the head at index 1_365 and starts the tail
    // 2_683 units before the end; emoji sit exactly on both cuts. Raising an
    // AgentRuntimeError keeps `normalizeAcpError` from bounding the message a
    // second time, so this pins this one bound instead of a bound of a bound.
    const rawFailure = `${'a'.repeat(1_364)}😀${'b'.repeat(300)}😀${'c'.repeat(2_650)}`;
    const headline = 'ACP adapter exited with code 1';
    expect(hasUnpairedSurrogate(rawFailure.slice(0, 1_365))).toBe(true);
    expect(hasUnpairedSurrogate(`${rawFailure}; ${headline}`.slice(1_667))).toBe(true);

    acpState.processExitListeners.at(-1)?.({ exitCode: 1, signal: null, stderrExcerpt: '' });
    acpState.prompt?.reject(new AgentRuntimeError('acp_request_failed', 'prompt', rawFailure, true));

    const failure = await turn.completion.then(
      () => null,
      (error: Error & { code?: string }) => error,
    );
    expect(failure).toMatchObject({ code: 'process_exit' });
    expect(failure?.message).toContain('chars omitted');
    expect(failure?.message.length).toBeLessThanOrEqual(4_096);
    expect(hasUnpairedSurrogate(failure?.message ?? '')).toBe(false);
    const projected = msgStore.getSnapshot().entries.map((entry) => entry.content).join('\n');
    expect(projected).toContain('chars omitted');
    expect(hasUnpairedSurrogate(projected)).toBe(false);

    await session.close();
  });

  it('never writes the process-exit log for a signal-terminated adapter', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const turn = await session.runTurn({
      turnId: 'turn-silent-exit',
      prompt: 'run the heavy test suite',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);

    acpState.processExitListeners.at(-1)?.({
      exitCode: null,
      signal: 'SIGTERM',
      stderrExcerpt: 'terminated by the operator',
    });
    expect(vi.mocked(writeErrorLog)).not.toHaveBeenCalled();

    acpState.prompt?.reject(new Error('ACP connection closed'));
    await expect(turn.completion).rejects.toMatchObject({
      code: 'process_exit',
      message: expect.stringContaining('signal SIGTERM'),
    });

    await session.close();
  });

  it('keeps the first exit fact and a single log line for a repeated same-generation exit', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const turn = await session.runTurn({
      turnId: 'turn-repeated-exit',
      prompt: 'run the heavy test suite',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);

    const listener = acpState.processExitListeners.at(-1);
    listener?.({ exitCode: 1, signal: null, stderrExcerpt: 'Fatal: first reported root cause' });
    listener?.({ exitCode: 1, signal: null, stderrExcerpt: 'late report without the root cause' });

    expect(vi.mocked(writeErrorLog)).toHaveBeenCalledTimes(1);
    acpState.prompt?.reject(new Error('ACP connection closed'));
    const failure = await turn.completion.then(
      () => null,
      (error: Error & { code?: string }) => error,
    );
    expect(failure).toMatchObject({ code: 'process_exit' });
    expect(failure?.message).toContain('Fatal: first reported root cause');
    expect(failure?.message).not.toContain('late report');

    await session.close();
  });

  it('does not let a retired generation exit rewrite the current turn failure', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const first = await session.runTurn({
      turnId: 'turn-retired-generation',
      prompt: 'poison the transport',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);
    const retiredExitListener = acpState.processExitListeners.at(-1);

    acpState.prompt?.reject(new AgentRuntimeError('protocol_violation', 'protocol', 'bad frame', false));
    await expect(first.completion).rejects.toMatchObject({ code: 'protocol_violation' });
    expect(acpState.processStarts).toBe(1);

    acpState.prompt = deferred<{ stopReason?: string }>();
    const second = await session.runTurn({
      turnId: 'turn-current-generation',
      prompt: 'continue',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);
    expect(acpState.processStarts).toBe(2);

    // The retired adapter settles after its replacement is already live.
    retiredExitListener?.({ exitCode: 1, signal: null, stderrExcerpt: 'Fatal: retired adapter root cause' });
    expect(vi.mocked(writeErrorLog)).toHaveBeenCalledTimes(1);
    acpState.prompt?.reject(new Error('ACP connection closed'));

    const failure = await second.completion.then(
      () => null,
      (error: Error & { code?: string }) => error,
    );
    expect(failure).toMatchObject({
      code: 'acp_request_failed',
      message: 'ACP connection closed',
    });
    expect(failure?.message).not.toContain('retired adapter root cause');

    await session.close();
  });

  it('keeps the transport failure reason when no adapter process exited', async () => {
    const { sink, input } = setup();
    const session = await new AcpRuntimeDriver().open(input, sink);
    const turn = await session.runTurn({
      turnId: 'turn-no-process-exit',
      prompt: 'fail without a process exit',
      msgStore: new MsgStore(),
      resumeExternalSessionId: 'external-1',
    }, sink);

    acpState.prompt?.reject(new Error('ACP connection closed'));

    await expect(turn.completion).rejects.toMatchObject({
      code: 'acp_request_failed',
      message: 'ACP connection closed',
    });
    expect(vi.mocked(writeErrorLog)).not.toHaveBeenCalled();

    await session.close();
  });
});
