import { describe, it, expect, vi } from 'vitest';
import { CodexCliControl } from '../codex-cli-control.js';
import { MsgStore } from '../../output/msg-store.js';
import type { CliDuplexIO } from '../../utils/cli-duplex-channel.js';
import type { RuntimePermissionRequest } from '@agent-tower/shared';

function setup(resumeThreadId?: string, responseFirst = false, executionPermission: 'ASK' | 'AUTO_SANDBOX' = 'ASK') {
  const frames: any[] = []; const requested: RuntimePermissionRequest[] = []; const failed = vi.fn(); const invalidated = vi.fn();
  const store = new MsgStore();
  let writeImpl: ((frame: any, current?: () => boolean) => Promise<void>) | undefined;
  const io: CliDuplexIO = { subscribe: vi.fn(), close: vi.fn(), end: vi.fn(), write: async (data, current) => {
    const m = JSON.parse(data); frames.push(m);
    if (writeImpl) return writeImpl(m, current);
    if (m.method === 'initialize') queueMicrotask(() => control.handle({ id: m.id, result: {} }));
    if (m.method === 'thread/start' || m.method === 'thread/resume') queueMicrotask(() => control.handle({ id: m.id, result: { thread: { id: 'thread' }, approvalPolicy: 'on-request', approvalsReviewer: executionPermission === 'AUTO_SANDBOX' ? 'auto_review' : 'user', sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } } }));
    if (m.method === 'turn/start') queueMicrotask(() => {
      if (responseFirst) {
        control.handle({ id: m.id, result: { turn: { id: 'native-turn' } } });
        control.handle({ id: 'early', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'native-turn', itemId: 'early-tool', command: 'preview' } });
      }
      control.handle({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'native-turn' } } });
      if (!responseFirst) control.handle({ id: m.id, result: { turn: { id: 'native-turn' } } });
    });
  } };
  const control = new CodexCliControl(io, store, { sessionId: 'session', turnId: 'tower-turn', runtimeInstanceId: 'generation', executionPermission, sensitiveValues: ['native-secret'] }, {
    requested: r => requested.push(r), invalidated, failed,
  });
  const params = { threadId: 'thread', turnId: 'native-turn', itemId: 'tool' };
  const notify = (method: string, extra: any = {}) => control.handle({ method, params: { ...params, ...extra } });
  const approval = (id: unknown = 0, method = 'item/commandExecution/requestApproval', extra: any = {}) => control.handle({ id, method, params: { ...params, command: 'printf native-secret TOKEN=private', ...extra } });
  const start = () => control.start(JSON.stringify({ cwd: '/workspace', ...(resumeThreadId ? { resumeThreadId } : {}), input: [{ type: 'text', text: 'task', text_elements: [] }] }), vi.fn());
  return { control, store, frames, requested, failed, invalidated, notify, approval, start, write: (fn: typeof writeImpl) => { writeImpl = fn; } };
}
describe('Codex app-server RPC approval contract', () => {
  it.each([undefined, 'thread'])('confirms ASK before the task on new/resumed thread %s', async resume => {
    const h = setup(resume); await h.start();
    expect(h.frames.map(m => m.method)).toEqual(['initialize', 'initialized', resume ? 'thread/resume' : 'thread/start', 'turn/start']);
    expect(h.frames[2].params).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' });
    expect(h.store.getSnapshot().sessionId).toBe('thread'); h.control.close();
  });
  it.each([undefined, 'thread'])('confirms AUTO_SANDBOX before the task on new/resumed thread %s', async resume => {
    const h = setup(resume, false, 'AUTO_SANDBOX'); await h.start();
    expect(h.frames[2].params).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' });
    expect(h.frames.at(-1)?.method).toBe('turn/start');
    h.control.close();
  });
  it.each([undefined, 'thread'])('reports native AUTO_SANDBOX rejection without starting a %s turn', async resume => {
    const h = setup(resume, false, 'AUTO_SANDBOX');
    h.write(async m => {
      if (m.method === 'initialize') queueMicrotask(() => h.control.handle({ id: m.id, result: {} }));
      else if (m.method === (resume ? 'thread/resume' : 'thread/start')) {
        queueMicrotask(() => h.control.handle({ id: m.id, error: { code: -32602, message: 'auto_review unsupported' } }));
      }
    });
    await expect(h.start()).rejects.toMatchObject({ code: 'permission_mode_unconfirmed', message: expect.stringContaining('auto_review') });
    expect(h.frames.some(frame => frame.method === 'turn/start')).toBe(false);
    h.control.close();
  });
  it('reports a native turn/start rejection under auto_review without changing mode', async () => {
    const h = setup(undefined, false, 'AUTO_SANDBOX');
    h.write(async m => {
      if (m.method === 'initialize') queueMicrotask(() => h.control.handle({ id: m.id, result: {} }));
      else if (m.method === 'thread/start') queueMicrotask(() => h.control.handle({ id: m.id, result: {
        thread: { id: 'thread' }, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
        sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
      } }));
      else if (m.method === 'turn/start') queueMicrotask(() => h.control.handle({ id: m.id, error: { code: -32602, message: 'unsupported model' } }));
    });
    await expect(h.start()).rejects.toMatchObject({ code: 'control_request_failed', message: expect.stringContaining('AUTO_SANDBOX') });
    expect(h.frames.filter(frame => frame.method === 'thread/start')).toHaveLength(1);
    expect(h.frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1);
    h.control.close();
  });
  it('keeps AUTO_SANDBOX unavailable when native reviewer or sandbox is not confirmed on resume', async () => {
    const h = setup('thread', false, 'AUTO_SANDBOX');
    h.write(async m => {
      if (m.method === 'initialize') queueMicrotask(() => h.control.handle({ id: m.id, result: {} }));
      else if (m.method === 'thread/resume') queueMicrotask(() => h.control.handle({ id: m.id, result: { thread: { id: 'thread' }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' } } }));
    });
    await expect(h.start()).rejects.toMatchObject({ code: 'permission_mode_unconfirmed' });
    expect(h.frames.some(m => m.method === 'turn/start')).toBe(false);
    h.control.close();
  });
  it.each([undefined, 'thread'])('rejects expanded or unconfirmed AUTO_SANDBOX boundaries before %s turn', async resume => {
    for (const sandbox of [
      { type: 'workspaceWrite', writableRoots: ['/outside'], networkAccess: false },
      { type: 'workspaceWrite', writableRoots: [], networkAccess: true },
      { type: 'workspaceWrite' },
    ]) {
      const h = setup(resume, false, 'AUTO_SANDBOX');
      h.write(async m => {
        if (m.method === 'initialize') queueMicrotask(() => h.control.handle({ id: m.id, result: {} }));
        else if (m.method === (resume ? 'thread/resume' : 'thread/start')) queueMicrotask(() => h.control.handle({ id: m.id, result: {
          thread: { id: 'thread' }, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox,
        } }));
      });
      await expect(h.start()).rejects.toMatchObject({ code: 'permission_mode_unconfirmed' });
      expect(h.frames.some(frame => frame.method === 'turn/start')).toBe(false);
      h.control.close();
    }
  });
  it('passes remaining native requests to the human approval flow under AUTO_SANDBOX', async () => {
    const h = setup(undefined, false, 'AUTO_SANDBOX'); await h.start();
    h.approval(7);
    expect(h.requested).toHaveLength(1);
    expect(h.frames.some(frame => frame.id === 7 && frame.result)).toBe(false);
    await h.control.resolve(h.requested[0].requestId, 'reject_once');
    expect(h.frames.at(-1)).toEqual({ id: 7, result: { decision: 'decline' } });
    h.control.close();
  });
  it.each(['approvalPolicy', 'approvalsReviewer', 'sandbox'])('does not send a task when %s is unconfirmed', async field => {
    const h = setup('thread');
    h.write(async m => {
      if (m.method === 'initialize') queueMicrotask(() => h.control.handle({ id: m.id, result: {} }));
      else if (m.method === 'thread/resume') queueMicrotask(() => h.control.handle({ id: m.id, result: { thread: { id: 'thread' }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' }, [field]: null } }));
    });
    await expect(h.start()).rejects.toMatchObject({ code: 'permission_mode_unconfirmed' });
    expect(h.frames.some(m => m.method === 'turn/start')).toBe(false); h.control.close();
  });
  it.each(['allow_once', 'reject_once'])('delivers %s once without native persistent grants or raw payload exposure', async option => {
    const h = setup(); await h.start(); h.approval(0, undefined, { availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['sh'] } }, 'cancel'] }); h.approval();
    expect(h.requested).toHaveLength(1);
    expect(h.requested[0]).toMatchObject({ turnId: 'tower-turn', runtimeInstanceId: 'generation', toolCallId: 'tool' });
    expect(JSON.stringify(h.requested)).not.toMatch(/native-secret|private/);
    expect(JSON.stringify(h.store.getSnapshot())).not.toContain('requestApproval');
    await h.control.resolve(h.requested[0].requestId, option);
    expect(h.frames.at(-1)).toEqual({ id: 0, result: { decision: option === 'allow_once' ? 'accept' : 'decline' } });
    await expect(h.control.resolve(h.requested[0].requestId, option)).rejects.toMatchObject({ code: 'permission_not_found' }); h.control.close();
  });
  it('projects concurrent commands, assistant deltas, file changes, MCP and per-turn usage', async () => {
    const h = setup(); await h.start();
    h.notify('item/started', { item: { id: 'a', type: 'agentMessage', text: '' } });
    h.notify('item/agentMessage/delta', { itemId: 'a', delta: 'streaming' });
    for (const id of ['one', 'two']) h.notify('item/started', { item: { id, type: 'commandExecution', command: id, status: 'inProgress' } });
    h.notify('item/commandExecution/outputDelta', { itemId: 'one', delta: 'output' });
    h.notify('item/completed', { item: { id: 'two', type: 'commandExecution', command: 'two', status: 'declined' } });
    h.notify('item/completed', { item: { id: 'one', type: 'commandExecution', command: 'one', status: 'completed', aggregatedOutput: 'final' } });
    h.notify('item/started', { item: { id: 'file', type: 'fileChange', changes: [{ path: '/outside/a.txt', kind: { type: 'add' }, diff: 'secret-diff' }] } });
    h.approval('file-request', 'item/fileChange/requestApproval', { itemId: 'file', command: undefined, grantRoot: null });
    expect(h.requested.at(-1)?.actionDetails).toContain('/outside/a.txt');
    expect(JSON.stringify(h.requested)).not.toContain('secret-diff');
    h.notify('item/completed', { item: { id: 'mcp', type: 'mcpToolCall', server: 'tower', tool: 'read', status: 'completed', result: 'mcp result' } });
    const completed = vi.fn(); h.control.onTurnCompleted(completed);
    h.notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 10, outputTokens: 5 }, total: { inputTokens: 1000 } } });
    h.notify('turn/completed', { turn: { id: 'native-turn', status: 'completed' } });
    h.notify('turn/completed', { turn: { id: 'native-turn', status: 'completed' } });
    const entries = h.store.getSnapshot().entries;
    expect(entries.find(e => e.id === 'a')?.content).toBe('streaming');
    expect(entries.find(e => e.id === 'one')).toMatchObject({ content: 'one\n\nOutput:\nfinal', metadata: { status: 'success' } });
    expect(entries.find(e => e.id === 'two')?.metadata?.status).toBe('denied');
    expect(entries.find(e => e.metadata?.tokenUsage)?.metadata?.tokenUsage?.totalTokens).toBe(15);
    expect(completed).toHaveBeenCalledTimes(1); h.control.close();
  });
  it('uses typed RPC IDs and invalidates only the matching native request', async () => {
    const h = setup(); await h.start(); h.approval(0); h.approval('0');
    h.notify('serverRequest/resolved', { requestId: 0 });
    await expect(h.control.resolve(h.requested[0].requestId, 'allow_once')).rejects.toMatchObject({ code: 'permission_not_found' });
    await h.control.resolve(h.requested[1].requestId, 'reject_once'); expect(h.frames.at(-1).id).toBe('0'); h.control.close();
  });
  it('bounds repeated command output and final aggregates while retaining entry identity and the latest tail', async () => {
    const h = setup(); await h.start();
    h.notify('item/started', { item: { id: 'large', type: 'commandExecution', command: 'large output', status: 'inProgress' } });
    const original = h.store.getSnapshot().entries.find(e => e.id === 'large')!;
    for (let i = 0; i < 5; i++) h.notify('item/commandExecution/outputDelta', { itemId: 'large', delta: `${i}:` + 'x'.repeat(32 * 1024) });
    h.notify('item/commandExecution/outputDelta', { itemId: 'large', delta: 'latest-tail' });
    let entry = h.store.getSnapshot().entries.find(e => e.id === 'large')!;
    expect(entry.content).toContain('[TRUNCATED]'); expect(entry.content).toContain('latest-tail');
    expect(entry.content.length).toBeLessThan(34 * 1024);
    h.notify('item/completed', { item: { id: 'large', type: 'commandExecution', command: 'large output', status: 'completed', aggregatedOutput: 'x'.repeat(256 * 1024) + 'final-tail' } });
    entry = h.store.getSnapshot().entries.find(e => e.id === 'large')!;
    expect(entry).toMatchObject({ id: original.id, timestamp: original.timestamp, metadata: { status: 'success' } });
    expect(entry.content).toContain('final-tail'); expect(entry.content.length).toBeLessThan(34 * 1024); h.control.close();
  });
  it('accepts turn/started after the turn/start response, but never another turn identity', async () => {
    const h = setup(undefined, true); await h.start();
    expect(h.requested).toHaveLength(1);
    h.notify('turn/started', { turn: { id: 'native-turn' } });
    expect(h.failed).not.toHaveBeenCalled();
    h.notify('turn/started', { turn: { id: 'another-turn' } });
    expect(h.failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'control_protocol_invalid' }));
  });
  it('rejects duplicates during a queued write and rechecks authorization at delivery', async () => {
    const h = setup(); await h.start(); h.approval();
    let allowed = true; let release!: () => void;
    h.write(async (_, current) => { await new Promise<void>(r => { release = r; }); current?.(); });
    const answer = h.control.resolve(h.requested[0].requestId, 'allow_once', () => { if (!allowed) throw Object.assign(new Error('revoked'), { statusCode: 403 }); });
    await expect(h.control.resolve(h.requested[0].requestId, 'allow_once')).rejects.toMatchObject({ code: 'permission_not_found' });
    allowed = false; release(); await expect(answer).rejects.toMatchObject({ statusCode: 403 }); expect(h.failed).toHaveBeenCalled();
  });
  it('never replays an uncertain allow after stdin failure', async () => {
    const h = setup(); await h.start(); h.approval(); h.write(async () => { throw new Error('EPIPE'); });
    await expect(h.control.resolve(h.requested[0].requestId, 'allow_once')).rejects.toThrow('EPIPE');
    expect(h.failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'control_write_failed' }));
    await expect(h.control.resolve(h.requested[0].requestId, 'allow_once')).rejects.toMatchObject({ code: 'permission_not_found' });
  });
  it.each(['item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'])('keeps %s separate from tool execution approvals', async method => {
    const h = setup(); await h.start(); h.approval('unsupported', method);
    expect(h.failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'native_interaction_unsupported' }));
    expect(h.frames.some(m => m.result?.decision)).toBe(false);
  });
  it('rejects an approval belonging to another native turn', async () => {
    const h = setup(); await h.start(); h.approval(0, undefined, { turnId: 'old-turn' });
    expect(h.failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'control_protocol_invalid' }));
  });
  it('bounds handshake and frame sizes, and consumes a valid final frame without newline', async () => {
    vi.useFakeTimers();
    try {
      const h = setup(); h.write(async () => {}); const start = h.start(); void start.catch(() => {});
      await vi.advanceTimersByTimeAsync(15000); await expect(start).rejects.toMatchObject({ code: 'control_handshake_timeout' }); h.control.close();
    } finally { vi.useRealTimers(); }
    const h = setup(); await h.start(); const completed = vi.fn(); h.control.onTurnCompleted(completed);
    h.control.processData(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'native-turn', status: 'completed' } } }));
    h.control.finish(); h.control.finish(); expect(completed).toHaveBeenCalledTimes(1); h.control.close();
    const oversized = setup(); oversized.control.processData('x'.repeat(8 * 1024 * 1024 + 1)); expect(oversized.failed).toHaveBeenCalled();
  });
});
