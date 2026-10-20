import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentType, RuntimeType } from '@agent-tower/shared';
import type { RuntimeOpenInput } from '../contracts.js';
import { ExecutionEnv } from '../../executors/execution-env.js';
import { MsgStore } from '../../output/msg-store.js';
import * as registry from '../acp/agents/registry.js';
import type { AcpAgentDefinition } from '../acp/agents/types.js';
import { AcpRuntimeDriver } from '../acp/acp-driver.js';

const transport = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('../acp/process-manager.js', () => ({ AcpProcessManager: class { start = transport.start; onExit() {} async stop() {} } }));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function tick() { await new Promise<void>(resolve => setImmediate(resolve)); }

describe('ACP real SDK prompt write evidence', () => {
  let output: ReadableStreamDefaultController<Uint8Array>;
  let written: Array<{ id: number; method: string; params: any }>;
  let ack: ReturnType<typeof deferred>;
  let failWrite: boolean;
  beforeEach(() => {
    ack = deferred(); written = []; failWrite = false;
    const reply = (id: number, result: object) => output.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'));
    transport.start.mockResolvedValue({ pid: 123, processGroupId: '123', birthMarker: 'birth', ownershipToken: 'owner',
      output: new ReadableStream<Uint8Array>({ start(controller) { output = controller; } }),
      input: new WritableStream<Uint8Array>({ async write(bytes) {
        const message = JSON.parse(new TextDecoder().decode(bytes)); written.push(message);
        if (message.method === 'initialize') reply(message.id, { protocolVersion: 1, agentCapabilities: {} });
        else if (message.method === 'session/new') reply(message.id, { sessionId: 'native-session' });
        else if (message.method === 'session/prompt') {
          // Deliberately return the model result before the OS write callback.
          reply(message.id, { stopReason: 'end_turn' }); await ack.promise;
          if (failWrite) throw new Error('stdin write failed');
        }
      } }),
    });
    vi.spyOn(registry, 'getAcpAgentDefinition').mockReturnValue({ agentType: AgentType.CODEX, displayName: 'controlled ACP',
      projectProvider: () => ({ agentType: AgentType.CODEX, permissionMode: 'FULL_ACCESS', environment: {} }),
      resolveLaunch: async (input: RuntimeOpenInput) => ({ command: 'controlled', args: [], cwd: input.workingDir, env: {} }),
    } as unknown as AcpAgentDefinition);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  async function open() {
    const sink = { stream: vi.fn(), process: vi.fn(async () => undefined) };
    const session = await new AcpRuntimeDriver().open({ towerSessionId: 'receipt-test', agentType: AgentType.CODEX, runtimeType: RuntimeType.ACP, variant: 'DEFAULT', workingDir: process.cwd(), env: ExecutionEnv.default(process.cwd()) }, sink);
    return { session, sink };
  }
  it('started and model completion cannot confirm submission; actual downstream write ACK does', async () => {
    const { session, sink } = await open();
    const before = vi.fn(async () => undefined); const after = vi.fn(async () => undefined);
    let returned = false;
    const turn = session.runTurn({ turnId: 'user-turn', prompt: 'English actual user text', msgStore: new MsgStore(), onSubmitting: before, onSubmitted: after }, sink).then(result => { returned = true; return result; });
    await tick(); await tick();
    expect(sink.process).toHaveBeenCalledWith(expect.objectContaining({ type: 'started' }));
    expect(written.filter(item => item.method === 'session/prompt')).toHaveLength(1);
    expect(before).toHaveBeenCalledTimes(1); expect(after).not.toHaveBeenCalled(); expect(returned).toBe(false);
    ack.resolve(); const handle = await turn; await handle.completion;
    expect(after).toHaveBeenCalledWith({ runtimeInstanceId: session.runtimeInstanceId, turnId: 'user-turn', transport: 'ACP_PROMPT_WRITE' });
    expect(written.find(item => item.method === 'session/prompt')!.params.prompt).toEqual([{ type: 'text', text: 'English actual user text' }]);
    await session.close();
  });
  it('a rejected downstream write never acknowledges SENT even when a model response already arrived', async () => {
    const { session, sink } = await open(); failWrite = true;
    const after = vi.fn(async () => undefined);
    const turn = session.runTurn({ turnId: 'failed-write', prompt: 'prose', msgStore: new MsgStore(), onSubmitting: async () => undefined, onSubmitted: after }, sink);
    const rejected = expect(turn).rejects.toThrow('stdin write failed');
    await tick(); await tick(); ack.resolve(); await rejected;
    expect(after).not.toHaveBeenCalled(); await session.close();
  });
});
