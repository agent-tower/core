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

const acpState = vi.hoisted(() => ({
  authMethods: [{ id: 'api-key', name: 'API Key' }] as Array<{ id: string; name: string }>,
  loadUpdates: [] as Array<{ sessionId: string; update: Record<string, unknown> }>,
  supportsResume: true,
  notificationHandler: undefined as undefined | ((request: { params: unknown }) => Promise<void>),
  permissionHandler: undefined as undefined | ((request: {
    params: Record<string, unknown>;
    signal: AbortSignal;
  }) => Promise<unknown>),
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
  const connection = {
    agent: { request: acpState.request, notify: acpState.notify },
    close: acpState.close,
    closed: new Promise<void>(() => undefined),
  };
  const app = {
    onNotification: vi.fn((_method: string, handler: typeof acpState.notificationHandler) => {
      acpState.notificationHandler = handler;
      return app;
    }),
    onRequest: vi.fn((_method: string, handler: typeof acpState.permissionHandler) => {
      acpState.permissionHandler = handler;
      return app;
    }),
    connect: vi.fn(() => connection),
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
    onExit() {}
    async stop() {
      acpState.processStops += 1;
      const error = acpState.processStopErrors.shift();
      if (error) throw error;
    }
  },
}));

import { AcpRuntimeDriver } from '../acp/acp-driver.js';

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
    env: ExecutionEnv.default(process.cwd()).set('CODEX_PATH', process.execPath),
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
  acpState.prompt = deferred<{ stopReason?: string }>();
  acpState.processStarts = 0;
  acpState.processStops = 0;
  acpState.processStopErrors = [];
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
    await expect(session.close()).resolves.toBeUndefined();
    expect(acpState.processStops).toBe(2);
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
});
