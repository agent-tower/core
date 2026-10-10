import { describe, it, expect, vi } from 'vitest';
import { ClaudeCliControl, describeClaudeAction } from '../claude-cli-control.js';
import type { CliDuplexIO } from '../../utils/cli-duplex-channel.js';
import type { RuntimePermissionRequest } from '@agent-tower/shared';

function setup() {
  const frames: any[] = [];
  const requested: RuntimePermissionRequest[] = [];
  const invalidated = vi.fn(); const failed = vi.fn();
  let writeImpl: ((frame: any, current?: () => boolean) => Promise<void>) | undefined;
  const io: CliDuplexIO = { subscribe: vi.fn(), end: vi.fn(), close: vi.fn(), write: async (data, current) => {
    const frame = JSON.parse(data); frames.push(frame);
    if (writeImpl) return writeImpl(frame, current);
    if (frame.type === 'control_request') queueMicrotask(() => control.handle({ type: 'control_response', response: {
      request_id: frame.request_id, subtype: 'success', response: frame.request.subtype === 'set_permission_mode' ? { mode: 'default' } : {},
    } }));
  } };
  const control = new ClaudeCliControl(io, { sessionId: 'session', turnId: 'turn', runtimeInstanceId: 'generation' }, { requested: r => requested.push(r), invalidated, failed });
  const request = (id = 'native', toolId: unknown = 'tool') => control.handle({ type: 'control_request', request_id: id,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: toolId, input: { command: 'printf secret', apiKey: 'hidden' } } });
  return { control, frames, requested, invalidated, failed, request, write: (fn: typeof writeImpl) => { writeImpl = fn; } };
}
const user = JSON.stringify({ type: 'user', message: { content: 'task' } });
describe('Claude native control protocol', () => {
  it('waits for initialize and explicit default confirmation before sending the task, including resume generations', async () => {
    for (let round = 0; round < 2; round++) {
      const h = setup(); await h.control.start(user);
      expect(h.frames.map(f => f.request?.subtype ?? f.type)).toEqual(['initialize', 'set_permission_mode', 'user']);
      h.control.close();
    }
  });
  it.each(['allow_once', 'reject_once'])('returns one native decision for %s and never persistent permission updates', async option => {
    const h = setup(); await h.control.start(user); h.request(); h.request();
    expect(h.requested).toHaveLength(1); expect(h.requested[0]).toMatchObject({ turnId: 'turn', runtimeInstanceId: 'generation', actionDetails: 'command: printf secret' });
    expect(JSON.stringify(h.requested)).not.toContain('hidden');
    await h.control.resolve(h.requested[0]!.requestId, option);
    const answer = h.frames.at(-1).response;
    expect(answer).toMatchObject({ subtype: 'success', request_id: 'native', response: { behavior: option === 'allow_once' ? 'allow' : 'deny', toolUseID: 'tool' } });
    expect(answer.response.updatedPermissions).toBeUndefined();
    if (option === 'allow_once') expect(answer.response.updatedInput.apiKey).toBe('hidden');
    await expect(h.control.resolve(h.requested[0]!.requestId, option)).rejects.toMatchObject({ code: 'permission_not_found' });
  });
  it('keeps consuming multiple requests and native cancellation while the user is waiting', async () => {
    const h = setup(); await h.control.start(user); h.request('one'); h.request('two');
    h.control.handle({ type: 'control_cancel_request', request_id: 'one' });
    expect(h.invalidated).toHaveBeenCalledWith(h.requested[0]!.requestId);
    await expect(h.control.resolve(h.requested[0]!.requestId, 'allow_once')).rejects.toMatchObject({ code: 'permission_not_found' });
    await h.control.resolve(h.requested[1]!.requestId, 'reject_once');
    expect(h.frames.at(-1).response.request_id).toBe('two');
  });
  it('atomically rejects duplicates while native write is pending; cancelled writes cannot be replayed', async () => {
    const h = setup(); await h.control.start(user); h.request();
    let release!: () => void;
    h.write(async (_, current) => { await new Promise<void>(r => { release = r; }); if (!current?.()) throw new Error('cancelled before write'); });
    const response = h.control.resolve(h.requested[0]!.requestId, 'allow_once');
    await expect(h.control.resolve(h.requested[0]!.requestId, 'reject_once')).rejects.toMatchObject({ code: 'permission_not_found' });
    h.control.handle({ type: 'control_cancel_request', request_id: 'native' }); release();
    await expect(response).rejects.toThrow(); expect(h.frames.filter(f => f.type === 'control_response')).toHaveLength(1);
  });
  it('invalidates all requests on write failure or stop and never retries allow', async () => {
    const h = setup(); await h.control.start(user); h.request();
    h.write(async () => { throw new Error('EPIPE'); });
    await expect(h.control.resolve(h.requested[0]!.requestId, 'allow_once')).rejects.toThrow('EPIPE');
    expect(h.failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'control_write_failed' }));
    await expect(h.control.resolve(h.requested[0]!.requestId, 'allow_once')).rejects.toMatchObject({ code: 'permission_not_found' });
  });
  it.each(['initialize', 'set_permission_mode'])('does not send a task when %s is rejected', async subtype => {
    const h = setup(); h.write(async frame => { queueMicrotask(() => h.control.handle({ type: 'control_response', response: {
      request_id: frame.request_id, subtype: frame.request.subtype === subtype ? 'error' : 'success', response: {},
    } })); });
    await expect(h.control.start(user)).rejects.toMatchObject({ code: 'control_request_failed' });
    expect(h.frames.some(f => f.type === 'user')).toBe(false); h.control.close();
  });
  it('requires positive mode evidence and fails closed on missing tool identity and unsupported questions', async () => {
    const h = setup(); h.write(async frame => { queueMicrotask(() => h.control.handle({ type: 'control_response', response: { request_id: frame.request_id, subtype: 'success', response: {} } })); });
    await expect(h.control.start(user)).rejects.toMatchObject({ code: 'permission_mode_unconfirmed' }); h.control.close();
    const valid = setup(); await valid.control.start(user); valid.request('bad', undefined);
    // Passing undefined uses the fixture default; null exercises a missing identity.
    valid.request('missing', null); expect(valid.failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'control_protocol_invalid' }));
    const question = setup(); await question.control.start(user);
    question.control.handle({ type: 'control_request', request_id: 'question', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion' } });
    expect(question.failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'native_interaction_unsupported' }));
  });
  it('rechecks deployment authorization immediately before a queued stdin write', async () => {
    const h = setup(); await h.control.start(user); h.request();
    let allowed = true; let deliver!: () => void;
    const authorize = () => { if (!allowed) throw Object.assign(new Error('revoked'), { statusCode: 403 }); };
    h.write(async (_, current) => { await new Promise<void>(r => { deliver = r; }); current?.(); });
    const answering = h.control.resolve(h.requested[0]!.requestId, 'allow_once', authorize);
    allowed = false; deliver();
    await expect(answering).rejects.toMatchObject({ statusCode: 403 });
    expect(h.failed).toHaveBeenCalled();
  });
  it('bounds handshake waits and does not send a task on initialization timeout', async () => {
    vi.useFakeTimers();
    try {
      const h = setup(); h.write(async () => {});
      const start = h.control.start(user); void start.catch(() => {});
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(start).rejects.toMatchObject({ code: 'control_handshake_timeout' });
      expect(h.frames.some(f => f.type === 'user')).toBe(false); h.control.close();
    } finally { vi.useRealTimers(); }
  });
  it('redacts sensitive command fields and bounds display size', () => {
    expect(describeClaudeAction({ command: 'TOKEN=abc password="secret" Bearer xyz' })).not.toMatch(/abc|secret|xyz/);
    expect(describeClaudeAction({ command: 'x'.repeat(9000) }).length).toBeLessThan(4100);
  });
});
