import { describe, expect, it } from 'vitest';
import type { NormalizedEntry } from '../../output/index.js';
import { reconcileAcpHistoryEntries } from '../acp/history-reconciler.js';
import { MsgStore } from '../../output/msg-store.js';
import { AcpProjector } from '../acp/projector.js';

function entry(
  id: string,
  content: string,
  entryType: NormalizedEntry['entryType'] = 'assistant_message',
  timestamp = 1,
): NormalizedEntry {
  return { id, content, entryType, timestamp };
}

describe('reconcileAcpHistoryEntries', () => {
  it('keeps reused native IDs in separate turns using only replayed user boundaries', () => {
    const live = new MsgStore();
    const replay = new MsgStore();
    const replayProjector = new AcpProjector(replay, { stream() {}, async process() {} });
    for (let turn = 1; turn <= 2; turn++) {
      live.textBlocks.admission = () => 7;
      live.textBlocks.begin(`turn-${turn}`);
      const liveProjector = new AcpProjector(live, { stream() {}, async process() {} });
      for (const [projector, revised] of [[liveProjector, false], [replayProjector, true]] as const) {
        projector.project({ sessionId: 'native', update: {
          sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `User ${turn}` },
        } } as never);
        projector.project({ sessionId: 'native', update: {
          sessionUpdate: 'agent_message_chunk', messageId: 'reused',
          content: { type: 'text', text: `${revised ? 'Revised' : 'Original'} answer ${turn}` },
        } } as never);
      }
      live.textBlocks.end();
    }
    const local = live.getSnapshot().entries;
    const merged = reconcileAcpHistoryEntries(local, replay.getSnapshot().entries)!;
    expect(merged.map(e => e.content)).toEqual(['Revised answer 1', 'Revised answer 2']);
    for (let index = 0; index < 2; index++) {
      expect(merged[index].id).toBe(local[index].id);
      const block = local[index].metadata!.textBlock!;
      expect(merged[index].metadata!.textBlock).toMatchObject({
        blockId: block.blockId, turnId: block.turnId, runtimeGeneration: block.runtimeGeneration,
        sourceRevision: 2, state: 'OPEN',
      });
      expect(merged[index].metadata!.textBlock!.translationEpoch).toBeUndefined();
    }
    expect(reconcileAcpHistoryEntries(merged, replay.getSnapshot().entries)).toBeUndefined();
  });

  it.each(['main', 'child'])('reserves later exact protocol occurrences before content fallback in %s', (streamId) => {
    const project = (store: MsgStore, items: Array<[string, string]>) => {
      const projector = new AcpProjector(store, { stream() {}, async process() {} });
      for (const [messageId, text] of items) {
        projector.project({ sessionId: 'native', update: {
          sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text },
          ...(streamId === 'child' ? { _meta: { claudeCode: { parentToolUseId: streamId } } } : {}),
        } } as never);
      }
    };
    const live = new MsgStore();
    live.textBlocks.begin('turn'); live.textBlocks.admission = () => 7;
    project(live, [['a', 'First'], ['b', 'Shared'], ['a', 'Last']]); live.textBlocks.end();
    const replay = new MsgStore();
    project(replay, [['new', 'Shared'], ['a', 'First corrected'], ['b', 'Shared corrected'], ['a', 'Last corrected']]);
    const local = live.getSnapshot().entries;
    const merged = reconcileAcpHistoryEntries(local, replay.getSnapshot().entries)!;
    expect(merged.map(e => e.content)).toEqual(['First corrected', 'Shared corrected', 'Last corrected', 'Shared']);
    for (let index = 0; index < local.length; index++) {
      expect(merged[index].id).toBe(local[index].id);
      expect(merged[index].metadata!.textBlock).toMatchObject({
        blockId: local[index].metadata!.textBlock!.blockId, sourceRevision: 2,
      });
    }
    expect(merged[3].metadata?.textBlock).toBeUndefined();
    expect(reconcileAcpHistoryEntries(merged, replay.getSnapshot().entries)).toBeUndefined();
  });

  it('reserves later legacy stable identities before recovering an ID drift by content', () => {
    const local = [entry('acp-message-a', 'First'), entry('acp-message-b', 'Shared'), entry('acp-message-old', 'Drift')];
    const replay = [entry('acp-message-new', 'Shared'), entry('acp-message-a', 'First corrected'),
      entry('acp-message-b', 'Shared corrected'), entry('acp-message-drift', 'Drift completed')];
    const merged = reconcileAcpHistoryEntries(local, replay)!;
    expect(merged.map(e => [e.id, e.content])).toEqual([
      ['acp-message-a', 'First corrected'], ['acp-message-b', 'Shared corrected'],
      ['acp-message-old', 'Drift completed'], ['acp-message-new', 'Shared'],
    ]);
    expect(reconcileAcpHistoryEntries(merged, replay)).toBeUndefined();
  });

  it.each([false, true])('recovers ID drift across interleaved streams (child exact: %s)', (childExact) => {
    const send = (projector: AcpProjector, messageId: string, text: string, child = false) => projector.project({ sessionId: 'native', update: {
      sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text },
      ...(child ? { _meta: { claudeCode: { parentToolUseId: 'child' } } } : {}),
    } } as never);
    const live = new MsgStore(); live.textBlocks.begin('turn');
    const liveProjector = new AcpProjector(live, { stream() {}, async process() {} });
    send(liveProjector, 'live-main', 'Main body'); send(liveProjector, 'live-child', 'Child body', true);
    live.textBlocks.end();
    const replay = new MsgStore(); const load = new AcpProjector(replay, { stream() {}, async process() {} });
    send(load, childExact ? 'live-child' : 'history-child', 'Child body completed', true);
    send(load, 'history-main', 'Main body completed');
    const original = live.getSnapshot().entries;
    const merged = reconcileAcpHistoryEntries(original, replay.getSnapshot().entries)!;
    expect(merged.map(e => e.content)).toEqual(['Main body completed', 'Child body completed']);
    expect(merged.map(e => e.id)).toEqual(original.map(e => e.id));
    expect(merged.map(e => e.metadata!.textBlock!.blockId)).toEqual(original.map(e => e.metadata!.textBlock!.blockId));
    expect(reconcileAcpHistoryEntries(merged, replay.getSnapshot().entries)).toBeUndefined();
  });

  it.each(['main', 'child'].flatMap(streamId => [
    { streamId, exact: 'Plan', drifted: 'Plan details' },
    { streamId, exact: 'Plan details', drifted: 'Plan' },
    { streamId, exact: 'Plan', drifted: 'Plan' },
  ]))('preserves mixed exact/drifted thoughts across complete loads ($streamId, $exact / $drifted)', ({ streamId, exact, drifted }) => {
    const sendTurn = (projector: AcpProjector, turn: number, replay: boolean) => {
      const send = (sessionUpdate: string, messageId: string, text: string) => projector.project({ sessionId: 'native', update: {
        sessionUpdate, messageId, content: { type: 'text', text },
        ...(streamId === 'child' ? { _meta: { claudeCode: { parentToolUseId: streamId } } } : {}),
      } } as never);
      send('user_message_chunk', `user-${turn}`, `User ${turn}`);
      send('agent_thought_chunk', turn === 1 ? 'a' : replay ? 'history-b' : 'live-b', turn === 1 ? exact : drifted);
      send('agent_message_chunk', `answer-${turn}`, `Answer ${turn}`);
    };
    const live = new MsgStore();
    for (let turn = 1; turn <= 2; turn++) {
      live.textBlocks.begin(`turn-${turn}`);
      sendTurn(new AcpProjector(live, { stream() {}, async process() {} }), turn, false);
      live.textBlocks.end();
    }
    const load = () => {
      const replay = new MsgStore();
      const projector = new AcpProjector(replay, { stream() {}, async process() {} });
      for (let turn = 1; turn <= 2; turn++) sendTurn(projector, turn, true);
      return replay.getSnapshot().entries;
    };
    const local = live.getSnapshot().entries;
    const localThoughts = local.filter(e => e.entryType === 'thinking');
    expect(localThoughts.map(e => e.content)).toEqual([exact, drifted]);
    const replay = load();
    expect(replay.map(e => e.id)).not.toEqual(local.map(e => e.id));
    const merged = reconcileAcpHistoryEntries(local, replay) ?? local;
    expect(merged.filter(e => e.entryType === 'thinking')).toEqual(localThoughts);
    expect(merged.map(e => [e.id, e.content])).toEqual(local.map(e => [e.id, e.content]));
    expect(merged).toEqual(local);
    expect(reconcileAcpHistoryEntries(merged, load())).toBeUndefined();
  });

  it.each(['main', 'child'])('does not let thinking content fallback consume a later exact thought in %s', (streamId) => {
    const project = (store: MsgStore, items: Array<[string, string]>) => {
      const projector = new AcpProjector(store, { stream() {}, async process() {} });
      for (const [messageId, text] of items) projector.project({ sessionId: 'native', update: {
        sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text },
        ...(streamId === 'child' ? { _meta: { claudeCode: { parentToolUseId: streamId } } } : {}),
      } } as never);
    };
    const live = new MsgStore(); project(live, [['old', 'Shared thought']]);
    const replay = new MsgStore(); project(replay, [['new', 'Shared thought'], ['old', 'Corrected thought']]);
    const original = live.getSnapshot().entries;
    const merged = reconcileAcpHistoryEntries(original, replay.getSnapshot().entries)!;
    expect(merged.map(e => e.content)).toEqual(['Corrected thought', 'Shared thought']);
    expect(merged[0].id).toBe(original[0].id);
    expect(reconcileAcpHistoryEntries(merged, replay.getSnapshot().entries)).toBeUndefined();
  });

  it('retains real Projector recovery when load changes native message IDs in the same stream', () => {
    const project = (store: MsgStore, messageId: string) => {
      const projector = new AcpProjector(store, { stream() {}, async process() {} });
      for (const [sessionUpdate, text] of [['agent_thought_chunk', 'A reason'], ['agent_message_chunk', 'An answer']]) projector.project({ sessionId: 'native', update: {
        sessionUpdate, messageId, content: { type: 'text', text },
      } } as never);
    };
    const live = new MsgStore(); live.textBlocks.begin('turn'); project(live, 'live-id'); live.textBlocks.end();
    const replay = new MsgStore(); project(replay, 'history-id');
    const local = live.getSnapshot().entries;
    const merged = reconcileAcpHistoryEntries(local, replay.getSnapshot().entries) ?? local;
    expect(merged).toHaveLength(2); expect(merged.map(e => e.id)).toEqual(local.map(e => e.id));
    expect(merged[1].metadata!.textBlock).toEqual(local[1].metadata!.textBlock);
  });
  it('updates a legacy stable message from actual replay even when its text is rewritten', () => {
    const original = entry(`acp-message-${Buffer.from('message-1').toString('base64url')}`, 'The answer is incorrect');
    const replay = new MsgStore();
    new AcpProjector(replay, { stream() {}, async process() {} }).project({ sessionId: 'native', update: {
      sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text: 'The answer is corrected' },
    } } as never);
    const merged = reconcileAcpHistoryEntries([original], replay.getSnapshot().entries)!;
    expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject({ id: original.id, timestamp: original.timestamp, content: 'The answer is corrected' });
  });
  it('does not let equal text consume another protocol message or child stream', () => {
    const project = (store: MsgStore, child: boolean) => new AcpProjector(store, { stream() {}, async process() {} }).project({ sessionId: 'native', update: {
      sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'Same text' },
      ...(child ? { _meta: { claudeCode: { parentToolUseId: 'child' } } } : {}),
    } } as never);
    const live = new MsgStore(); project(live, false);
    const replay = new MsgStore(); project(replay, true); project(replay, false);
    const local = live.getSnapshot().entries;
    const merged = reconcileAcpHistoryEntries(local, replay.getSnapshot().entries)!;
    expect(merged).toHaveLength(2); expect(merged[0].id).toBe(local[0].id);
    expect(merged[1].metadata!.acpTextIdentity).not.toEqual(local[0].metadata!.acpTextIdentity);
  });
  it('matches actual live/replay protocol identities across revisions, segments, substreams and turns', () => {
    const live = new MsgStore(); const replay = new MsgStore();
    const replayProjector = new AcpProjector(replay, { stream() {}, async process() {} });
    const project = (store: MsgStore, turn: number, revised: boolean, projector = new AcpProjector(store, { stream() {}, async process() {} })) => {
      const send = (sessionUpdate: string, text: string, child = false) => projector.project({ sessionId: 'native-session', update: {
        sessionUpdate, messageId: 'same-message', content: { type: 'text', text },
        ...(child ? { _meta: { claudeCode: { parentToolUseId: 'child' } } } : {}),
      } } as never);
      send('user_message_chunk', `User ${turn}`);
      send('agent_message_chunk', revised ? `Corrected answer ${turn}` : `Incorrect answer ${turn}`);
      send('agent_message_chunk', ' tail');
      send('agent_message_chunk', `Child ${turn}`, true);
      send('agent_thought_chunk', `Thinking ${turn}`);
      send('agent_message_chunk', `Second segment ${turn}`);
    };
    for (let turn = 1; turn <= 2; turn++) {
      live.textBlocks.admission = () => 7; live.textBlocks.begin(`turn-${turn}`);
      project(live, turn, false); live.textBlocks.end(); project(replay, turn, true, replayProjector);
    }
    const originals = live.getSnapshot().entries;
    const merged = reconcileAcpHistoryEntries(originals, replay.getSnapshot().entries)!;
    expect(merged).toHaveLength(originals.length);
    expect(merged.filter(e => e.entryType === 'assistant_message')).toHaveLength(6);
    for (let i = 0; i < merged.length; i++) {
      expect(merged[i].id).toBe(originals[i].id); expect(merged[i].timestamp).toBe(originals[i].timestamp);
      const block = originals[i].metadata?.textBlock;
      if (!block) continue;
      expect(merged[i].metadata!.textBlock).toMatchObject({ blockId: block.blockId, turnId: block.turnId, runtimeGeneration: block.runtimeGeneration });
      if (originals[i].content.startsWith('Incorrect')) {
        expect(merged[i].content).toContain('Corrected');
        expect(merged[i].metadata!.textBlock).toMatchObject({ state: 'OPEN', sourceRevision: 2 });
        expect(merged[i].metadata!.textBlock!.translationEpoch).toBeUndefined();
      } else expect(merged[i].metadata!.textBlock).toEqual(block);
    }
    expect(reconcileAcpHistoryEntries(merged, replay.getSnapshot().entries)).toBeUndefined();
  });
  it('does nothing when replayed history already exists locally', () => {
    const local = [entry('acp-message-one', 'complete', 'assistant_message', 10)];
    const replayed = [entry('acp-message-one', 'complete', 'assistant_message', 20)];

    expect(reconcileAcpHistoryEntries(local, replayed)).toBeUndefined();
  });

  it('replaces a partial stable message without duplicating it', () => {
    const local = [entry('acp-message-one', 'part', 'assistant_message', 10)];
    const replayed = [entry('acp-message-one', 'partial response completed', 'assistant_message', 20)];

    expect(reconcileAcpHistoryEntries(local, replayed)).toEqual([
      entry('acp-message-one', 'partial response completed', 'assistant_message', 10),
    ]);
  });

  it('matches replayed assistant messages when Codex changes live IDs to history item IDs', () => {
    const local = [entry('acp-message-live-msg', 'same response', 'assistant_message', 10)];
    const replayed = [entry('acp-message-history-item', 'same response', 'assistant_message', 20)];

    expect(reconcileAcpHistoryEntries(local, replayed)).toBeUndefined();
  });

  it('completes an ID-drifted partial assistant message in place', () => {
    const local = [entry('acp-message-live-msg', 'partial response', 'assistant_message', 10)];
    const replayed = [entry('acp-message-history-item', 'partial response completed', 'assistant_message', 20)];

    expect(reconcileAcpHistoryEntries(local, replayed)).toEqual([
      entry('acp-message-live-msg', 'partial response completed', 'assistant_message', 10),
    ]);
  });

  it('matches replayed thinking when load combines multiple live reasoning entries', () => {
    const local = [
      entry('acp-thought-live-one', 'Plan the ', 'thinking'),
      entry('acp-tool-read', 'read output', 'tool_use'),
      entry('acp-thought-live-two', 'implementation', 'thinking'),
    ];
    const replayed = [entry('acp-thought-history-item', 'Plan theimplementation', 'thinking')];

    expect(reconcileAcpHistoryEntries(local, replayed)).toBeUndefined();
  });

  it('keeps legitimate repeated assistant messages using occurrence-aware matching', () => {
    const local = [entry('acp-message-live-one', 'Done')];
    const replayed = [
      entry('acp-message-history-one', 'Done'),
      entry('acp-message-history-two', 'Done'),
    ];

    expect(reconcileAcpHistoryEntries(local, replayed)).toEqual([
      local[0],
      replayed[1],
    ]);
  });

  it('inserts missing loaded history before the current local user message', () => {
    const local = [
      entry('acp-message-live-one', 'Known response'),
      entry('current-user', 'Continue', 'user_message'),
    ];
    const replayed = [
      entry('acp-message-history-one', 'Known response'),
      entry('acp-message-history-two', 'Recovered response'),
    ];

    expect(reconcileAcpHistoryEntries(local, replayed, {
      historyBoundaryEntryId: 'current-user',
    })).toEqual([
      local[0],
      replayed[1],
      local[1],
    ]);
  });

  it('appends stable messages and tools that are missing locally', () => {
    const local = [entry('local-user', 'continue', 'user_message')];
    const replayed = [
      entry('acp-message-two', 'answer'),
      entry('acp-tool-read', 'read output', 'tool_use'),
    ];

    expect(reconcileAcpHistoryEntries(local, replayed)).toEqual([...local, ...replayed]);
  });

  it('updates stable plan and usage entries in place', () => {
    const local = [
      entry('acp-plan', 'old plan', 'tool_use'),
      entry('acp-usage', '10 tokens', 'token_usage_info'),
    ];
    const replayed = [
      entry('acp-plan', 'current plan', 'tool_use'),
      entry('acp-usage', '20 tokens', 'token_usage_info'),
    ];

    expect(reconcileAcpHistoryEntries(local, replayed)).toEqual(replayed);
  });

  it('heals duplicate local ACP identities', () => {
    const local = [
      entry('acp-message-one', 'partial'),
      entry('acp-message-one', 'duplicate partial'),
    ];

    expect(reconcileAcpHistoryEntries(local, [])).toEqual([
      entry('acp-message-one', 'partial'),
    ]);
  });

  it('matches anonymous entries by occurrence instead of collapsing equal entries globally', () => {
    const anonymous = entry('random-one', 'same warning', 'warning_message');
    const replayed = [
      entry('random-two', 'same warning', 'warning_message'),
      entry('random-three', 'same warning', 'warning_message'),
    ];

    expect(reconcileAcpHistoryEntries([anonymous], replayed)).toEqual([
      anonymous,
      replayed[1],
    ]);
  });

  it('keeps local user messages authoritative', () => {
    const local = [entry('local-user', 'edited local message', 'user_message')];
    const replayed = [entry('remote-user', 'replayed message', 'user_message')];

    expect(reconcileAcpHistoryEntries(local, replayed)).toBeUndefined();
  });

  it('handles large histories without changing an exact replay', () => {
    const local = Array.from({ length: 5_000 }, (_, index) => (
      entry(`acp-message-${index}`, `message ${index}`, 'assistant_message', index)
    ));
    const replayed = local.map((item) => ({ ...item, timestamp: item.timestamp + 1 }));

    expect(reconcileAcpHistoryEntries(local, replayed)).toBeUndefined();
  });
});
