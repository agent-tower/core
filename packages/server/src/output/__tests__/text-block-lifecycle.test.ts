import { describe, expect, it, vi } from 'vitest';
import { MsgStore } from '../msg-store.js';
import { ClaudeCodeParser } from '../claude-code-parser.js';
import { CodexParser } from '../codex-parser.js';
import { CursorAgentParser } from '../cursor-agent-parser.js';
import { GeminiParser } from '../gemini-parser.js';
import { AcpProjector } from '../../runtime/acp/projector.js';
import { CodexCliProjector } from '../../runtime/codex-cli-projector.js';
import { addNormalizedEntry, replaceNormalizedEntry, updateEntryContent } from '../utils/patch.js';
import { createAssistantMessage, createToolUse } from '../types.js';
import type { NormalizedEntry } from '../types.js';

function setup() {
  const store = new MsgStore();
  const sealed: NormalizedEntry[] = [];
  store.textBlocks.admission = () => 7;
  store.textBlocks.begin('turn-1');
  store.onTextBlock(entry => { if (entry.metadata?.textBlock?.state === 'SEALED') sealed.push(entry); });
  return { store, sealed };
}
function feed(parser: { processData(data: string): void }, event: unknown) { parser.processData(`${JSON.stringify(event)}\n`); }
const bodies = (store: MsgStore) => store.getSnapshot().entries.filter(e => e.entryType === 'assistant_message');

// Shapes verified against Claude stream-json, Codex exec/app-server v2,
// Gemini CLI 0.27.0 nonInteractiveCli/core output types, ACP SDK 1.4.0.
describe('canonical assistant block lifecycle protocol fixtures', () => {
  it('Claude seals at tool block start before its summary, isolates child streams, and versions final summaries', () => {
    const { store, sealed } = setup();
    const parser = new ClaudeCodeParser(store);
    feed(parser, { type: 'stream_event', event: { type: 'message_start', message: { id: 'm', role: 'assistant' } } });
    feed(parser, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'A' } } });
    feed(parser, { type: 'stream_event', parent_tool_use_id: 'child', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'ct', name: 'bash', input: {} } } });
    expect(sealed).toHaveLength(0);
    feed(parser, { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't', name: 'bash', input: {} } } });
    expect(sealed.map(e => e.content)).toEqual(['A']);
    const block = sealed[0].metadata!.textBlock!;
    feed(parser, { type: 'assistant', message: { id: 'm', stop_reason: 'tool_use', content: [{ type: 'text', text: 'A revised' }, { type: 'tool_use', id: 't', name: 'bash', input: {} }] } });
    expect(bodies(store)[0]).toMatchObject({ id: sealed[0].id, content: 'A revised', metadata: { textBlock: { blockId: block.blockId, sourceRevision: 2, state: 'SEALED' } } });
    const count = sealed.length;
    feed(parser, { type: 'assistant', message: { id: 'm', stop_reason: 'tool_use', content: [{ type: 'text', text: 'A revised' }, { type: 'tool_use', id: 't', name: 'bash', input: {} }] } });
    expect(sealed).toHaveLength(count);
    feed(parser, { type: 'stream_event', event: { type: 'message_start', message: { id: 'm2', role: 'assistant' } } });
    feed(parser, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'B' } } });
    store.textBlocks.end();
    expect(sealed.at(-1)).toMatchObject({ content: 'B', metadata: { textBlock: { sealedReason: 'TURN_END' } } });
    expect(bodies(store)[0].id).not.toBe(bodies(store)[1].id);
  });

  it('Claude explicit stop seals once and allocates a new row for the next text block', () => {
    const { store, sealed } = setup(); const parser = new ClaudeCodeParser(store);
    for (let index = 0; index < 2; index++) {
      feed(parser, { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text', text: String(index) } } });
      feed(parser, { type: 'stream_event', event: { type: 'content_block_stop', index } });
      feed(parser, { type: 'stream_event', event: { type: 'content_block_stop', index } });
    }
    expect(sealed).toHaveLength(2); expect(bodies(store)).toHaveLength(2);
  });

  it.each([false, true])('Claude historical summaries leave the current body open (earlier summary: %s)', earlierSummary => {
    const { store, sealed } = setup(); const parser = new ClaudeCodeParser(store);
    const stream = (event: object) => feed(parser, { type: 'stream_event', event });
    stream({ type: 'message_start', message: { id: 'A', role: 'assistant' } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'Reason A' } });
    stream({ type: 'content_block_stop', index: 0 });
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'Body A' } });
    stream({ type: 'content_block_stop', index: 1 }); stream({ type: 'message_stop' });
    const summary = { type: 'assistant', message: { id: 'A', stop_reason: 'tool_use', content: [
      { type: 'thinking', thinking: 'Reason A' }, { type: 'text', text: 'Body A' },
      { type: 'tool_use', id: 'tool-A', name: 'bash', input: { command: 'echo A' } },
    ] } };
    if (earlierSummary) feed(parser, summary);
    stream({ type: 'message_start', message: { id: 'B', role: 'assistant' } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Body B' } });
    const block = bodies(store)[1].metadata!.textBlock!;
    feed(parser, summary); feed(parser, summary);
    expect(bodies(store)[1].metadata!.textBlock).toEqual(block);
    expect(sealed.map(e => e.content)).toEqual(['Body A']);
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' continued' } });
    expect(bodies(store)).toHaveLength(2); expect(bodies(store)[1].content).toBe('Body B continued');
    stream({ type: 'content_block_stop', index: 0 });
    expect(sealed.map(e => e.content)).toEqual(['Body A', 'Body B continued']);
    // A real new semantic block still closes the current body immediately.
    stream({ type: 'message_start', message: { id: 'C', role: 'assistant' } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Body C' } });
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'New reason' } });
    expect(sealed.at(-1)).toMatchObject({ content: 'Body C', metadata: { textBlock: { sealedReason: 'TYPE_SWITCH' } } });
  });

  it.each([undefined, 7])('keeps begun streaming history compressible with admission %s', epoch => {
    const count = 1200;
    const baseline = new MsgStore(); const store = new MsgStore();
    store.textBlocks.admission = () => epoch; store.textBlocks.begin('streaming-turn');
    const seqs: number[] = []; const contentPatches: number[] = [];
    store.onPatch((patch, seq) => { seqs.push(seq); if (patch[0].path.endsWith('/content')) contentPatches.push(patch.length); });
    for (const target of [baseline, store]) target.pushPatch(addNormalizedEntry(0, createAssistantMessage('')));
    const initial = store.getSnapshot().entries[0].metadata!.textBlock!;
    for (let index = 1; index <= count; index++) {
      for (const target of [baseline, store]) target.pushPatch(updateEntryContent(0, 'body '.repeat(index)));
      if (index === 600) expect(store.getSnapshot().entries[0].content).toBe('body '.repeat(index));
    }
    store.textBlocks.complete(0);
    expect(baseline.getMessages()).toHaveLength(2);
    expect(store.getMessages().length).toBeLessThanOrEqual(baseline.getMessages().length + 1);
    expect(contentPatches).toEqual(Array(count).fill(1));
    const snapshot = store.getSnapshot();
    expect(snapshot.entries[0].content).toBe(baseline.getSnapshot().entries[0].content);
    expect(snapshot.entries[0].metadata!.textBlock).toMatchObject({ ...initial, state: 'SEALED', sealedReason: 'EXPLICIT' });
    expect(snapshot.entries[0].metadata!.textBlock!.translationEpoch).toBe(epoch);
    expect(snapshot.seq).toBe(count + 2); expect(seqs).toEqual(Array.from({ length: count + 2 }, (_, i) => i + 1));
  });

  it('Codex exec completes an item immediately and repeated completed items retain block identity', () => {
    const { store, sealed } = setup(); const parser = new CodexParser(store);
    const event = { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'A' } };
    feed(parser, event); feed(parser, event);
    expect(sealed).toHaveLength(1); expect(bodies(store)).toHaveLength(1);
    expect(sealed[0].metadata?.textBlock?.sealedReason).toBe('EXPLICIT');
  });

  it('Codex app-server preserves started/delta/completed boundaries and namespaces reused native IDs', () => {
    const { store, sealed } = setup(); let projector = new CodexCliProjector(store);
    projector.item({ id: 'x', type: 'agentMessage', text: '' });
    projector.delta('item/agentMessage/delta', 'x', 'A');
    expect(bodies(store)[0].content).toBe('A'); expect(sealed).toHaveLength(0);
    projector.item({ id: 'tool', type: 'commandExecution', command: 'echo SECRET' });
    expect(sealed[0].content).toBe('A');
    projector.item({ id: 'y', type: 'agentMessage', text: 'B' }, true);
    expect(sealed.at(-1)?.content).toBe('B');
    const id = bodies(store)[0].id;
    store.textBlocks.end(); store.textBlocks.begin('turn-2'); projector = new CodexCliProjector(store);
    projector.item({ id: 'x', type: 'agentMessage', text: 'new turn' }, true);
    expect(bodies(store).at(-1)?.id).not.toBe(id);
  });

  it('Cursor seals at thinking/tool and retry revision invalidates an earlier sealed body', () => {
    const { store, sealed } = setup(); const parser = new CursorAgentParser(store);
    feed(parser, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A' }] } });
    feed(parser, { type: 'thinking', subtype: 'delta', text: 'THINKING SECRET' });
    expect(sealed[0].content).toBe('A');
    feed(parser, { type: 'retry', subtype: 'resuming', attempt: 1, is_resume: true });
    feed(parser, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Revised' }] } });
    feed(parser, { type: 'result', subtype: 'success' });
    expect(bodies(store)[0]).toMatchObject({ content: 'Revised', metadata: { textBlock: { blockId: sealed[0].metadata!.textBlock!.blockId, sourceRevision: 2, state: 'SEALED' } } });
  });

  it('Gemini 0.27 stream-json streams originals, seals on tool_use and only closes the tail at result', () => {
    const { store, sealed } = setup(); const parser = new GeminiParser(store);
    const completed = vi.fn(() => store.textBlocks.end()); parser.onTurnCompleted(completed);
    feed(parser, { type: 'init', timestamp: '2026-10-16T00:00:00Z', session_id: 'native-session', model: 'gemini' });
    feed(parser, { type: 'message', role: 'user', content: 'USER SECRET' });
    feed(parser, { type: 'message', role: 'assistant', content: 'A', delta: true });
    feed(parser, { type: 'message', role: 'assistant', content: 'A', delta: true });
    expect(bodies(store)[0].content).toBe('AA'); expect(sealed).toHaveLength(0);
    feed(parser, { type: 'tool_use', tool_id: 't', tool_name: 'read_file', parameters: { path: '/SECRET' } });
    expect(sealed.map(e => e.content)).toEqual(['AA']);
    feed(parser, { type: 'tool_result', tool_id: 't', status: 'success', output: 'TOOL SECRET' });
    feed(parser, { type: 'message', role: 'assistant', content: 'B', delta: true });
    expect(sealed).toHaveLength(1);
    feed(parser, { type: 'result', status: 'success', stats: { total_tokens: 100 } });
    feed(parser, { type: 'result', status: 'success' }); parser.finish();
    expect(sealed.map(e => e.content)).toEqual(['AA', 'B']); expect(completed).toHaveBeenCalledTimes(1);
  });

  it('ACP standard chunks segment the same message ID across thought/tool/non-text and isolate Claude substreams', () => {
    const { store, sealed } = setup(); const projector = new AcpProjector(store, { stream() {}, async process() {} });
    const update = (value: object) => projector.project({ sessionId: 'native', update: value } as never);
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'A' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'child-tool', title: 'Child', _meta: { claudeCode: { parentToolUseId: 'child' } } });
    expect(sealed).toHaveLength(0);
    update({ sessionUpdate: 'usage_update', used: 100 }); expect(sealed).toHaveLength(0);
    update({ sessionUpdate: 'agent_thought_chunk', messageId: 'm', content: { type: 'text', text: 'THOUGHT SECRET' } });
    expect(sealed.map(e => e.content)).toEqual(['A']);
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'B' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'SECRET', mimeType: 'image/png' } });
    expect(sealed.map(e => e.content)).toEqual(['A', 'B']); expect(bodies(store)).toHaveLength(2);
    update({ sessionUpdate: 'agent_message_chunk', _meta: { qwenDiscreteMessage: true }, content: { type: 'text', text: 'C' } });
    expect(sealed.map(e => e.content)).toEqual(['A', 'B', 'C']);
  });

  it('cancel aborts the unfinished body while already sealed bodies remain eligible; observers cannot fail output', () => {
    const { store, sealed } = setup(); store.onTextBlock(() => { throw new Error('observer unavailable'); });
    store.pushPatch(addNormalizedEntry(0, createAssistantMessage('A'))); store.textBlocks.complete(0);
    store.pushPatch(addNormalizedEntry(1, createAssistantMessage('B'))); store.textBlocks.cancel();
    store.pushPatch(updateEntryContent(1, 'B tail')); store.textBlocks.end(true);
    expect(sealed.map(e => e.content)).toEqual(['A']);
    expect(bodies(store)[1]).toMatchObject({ content: 'B tail', metadata: { textBlock: { state: 'ABORTED' } } });
  });

  it('a late completed summary cannot steal the next open segment from turn finalization', () => {
    const { store, sealed } = setup();
    store.pushPatch(addNormalizedEntry(0, createAssistantMessage('A'))); store.textBlocks.complete(0);
    store.pushPatch(addNormalizedEntry(1, createAssistantMessage('B')));
    store.pushPatch(replaceNormalizedEntry(0, createAssistantMessage('A final'))); store.textBlocks.complete(0);
    store.textBlocks.end();
    expect(sealed.map(entry => entry.content)).toEqual(['A', 'A final', 'B']);
    expect(bodies(store)[1].metadata?.textBlock?.sealedReason).toBe('TURN_END');
  });

  it('restore/replay does not admit static history and stale turn finalizers cannot close the next turn', () => {
    const { store } = setup(); store.pushPatch(addNormalizedEntry(0, createAssistantMessage('A'))); store.textBlocks.complete(0);
    const restored = new MsgStore(); restored.restoreFromSnapshot(store.getSnapshot()); restored.textBlocks.begin('turn-2');
    const observer = vi.fn(); restored.onTextBlock(observer);
    restored.pushPatch([{ op: 'replace', path: '/entries', value: store.getSnapshot().entries }]);
    expect(observer).not.toHaveBeenCalled();
    restored.pushPatch(addNormalizedEntry(1, createAssistantMessage('B'))); restored.textBlocks.end(true, 'old-turn');
    expect(bodies(restored)[1].metadata?.textBlock?.state).toBe('OPEN');
    restored.pushPatch(replaceNormalizedEntry(1, createAssistantMessage('B revised')));
    expect(bodies(restored)[1].metadata?.textBlock?.sourceRevision).toBe(1);
  });
});
