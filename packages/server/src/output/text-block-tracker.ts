import { randomUUID } from 'node:crypto';
import type { TextBlockLifecycle } from '@agent-tower/shared';
import type { MsgStore } from './msg-store.js';
import type { JsonPatch, NormalizedEntry } from './types.js';

/** Per-turn semantic streams at the canonical transcript commit boundary. */
export class TextBlockTracker {
  private turn?: { id: string; generation: string };
  private stream = 'main';
  private entries = new Map<number, NormalizedEntry>();
  private active = new Map<string, number>();
  private changed = new Set<number>();
  private internal = false;
  private cancelling = false;
  private reconciling = false;
  get isLifecyclePatch(): boolean { return this.internal; }
  cancel(): void { this.cancelling = true; }
  admission: () => number | undefined = () => undefined;

  constructor(private readonly store: MsgStore) {}

  begin(turnId: string): void {
    this.cancelling = false;
    this.turn = { id: turnId, generation: randomUUID() };
    this.entries.clear();
    this.active.clear();
    this.changed.clear();
  }

  inStream<T>(streamId: string, action: () => T): T {
    const previous = this.stream;
    this.stream = streamId;
    try { return action(); } finally { this.stream = previous; }
  }

  /** Historical summaries can revise their own nodes without advancing the live stream. */
  reconcile<T>(action: () => T): T {
    const previous = this.reconciling;
    this.reconciling = true;
    try { return action(); } finally { this.reconciling = previous; }
  }

  boundary(streamId = this.stream): void { if (!this.reconciling) this.seal(this.active.get(streamId), 'TYPE_SWITCH'); }
  complete(index: number): void { this.seal(index, 'EXPLICIT'); }

  end(cancelled = false, turnId?: string): void {
    if (turnId && this.turn?.id !== turnId) return;
    for (const [index, entry] of this.entries) if (entry.metadata?.textBlock?.state === 'OPEN') this.seal(index, 'TURN_END', cancelled);
    this.turn = undefined;
    this.entries.clear();
    this.active.clear();
    this.changed.clear();
  }

  private seal(index: number | undefined, reason: TextBlockLifecycle['sealedReason'], cancelled = false): void {
    if (index === undefined) return;
    const entry = this.entries.get(index);
    const block = entry?.metadata?.textBlock;
    if (!entry || !block || block.state !== 'OPEN') return;
    const next: NormalizedEntry = { ...entry, metadata: { ...entry.metadata, textBlock: { ...block, state: cancelled || this.cancelling ? 'ABORTED' : 'SEALED', sealedReason: reason } } };
    this.entries.set(index, next);
    if (this.active.get(block.streamId) === index) this.active.delete(block.streamId);
    this.internal = true;
    try { this.store.pushPatch([{ op: 'add', path: `/entries/${index}/metadata`, value: next.metadata }]); }
    finally { this.internal = false; }
    this.store.notifyTextBlock(next);
  }

  decorate(patch: JsonPatch): void {
    if (!this.turn || this.internal) return;
    for (const op of patch) {
      const match = /^\/entries\/(\d+)(?:\/(content|metadata))?$/.exec(op.path);
      if (!match || !['add', 'replace'].includes(op.op)) continue;
      const index = Number(match[1]);
      const previous = this.entries.get(index);
      let entry: NormalizedEntry;
      if (!match[2]) entry = op.value as NormalizedEntry;
      else if (previous && match[2] === 'content') entry = { ...previous, content: op.value as string };
      else continue;
      if (!entry || typeof entry.content !== 'string') continue;
      if (entry.entryType !== 'assistant_message') {
        // Updating an existing tool/thinking node does not move the stream cursor.
        if (previous?.entryType !== entry.entryType && !['user_message', 'token_usage_info', 'loading', 'next_action'].includes(entry.entryType)) this.boundary();
        this.entries.set(index, entry);
        continue;
      }
      let block = previous?.metadata?.textBlock;
      const contentChanged = previous?.content !== entry.content;
      if (!block) {
        const current = this.active.get(this.stream);
        if (!this.reconciling && current !== undefined && current !== index) this.seal(current, 'EXPLICIT');
        block = { turnId: this.turn.id, runtimeGeneration: this.turn.generation, streamId: this.stream, blockId: randomUUID(), semanticType: 'assistant_message', sourceRevision: 1, state: 'OPEN' };
        this.changed.add(index);
      } else if (contentChanged && block.state !== 'OPEN') {
        const { sealedReason: _reason, ...open } = block;
        block = { ...open, sourceRevision: block.sourceRevision + 1, state: 'OPEN' };
        this.changed.add(index);
      }
      let epoch: number | undefined;
      try { epoch = this.admission(); } catch { /* Translation configuration is an optional observer. */ }
      if (contentChanged && epoch !== undefined && block.translationEpoch !== epoch) block = { ...block, translationEpoch: epoch };
      entry = { ...entry, id: previous?.id ?? randomUUID(), timestamp: previous?.timestamp ?? entry.timestamp, metadata: { ...entry.metadata, textBlock: block } };
      this.entries.set(index, entry);
      if (!this.reconciling && block.state === 'OPEN' && (!this.active.has(block.streamId) || this.active.get(block.streamId) === index)) this.active.set(block.streamId, index);
      if (!match[2]) op.value = entry;
      else if (block !== previous?.metadata?.textBlock) patch.push({ op: 'add', path: `/entries/${index}/metadata`, value: entry.metadata });
    }
  }

  committed(): void {
    if (this.internal) return;
    const changed = [...this.changed];
    this.changed.clear();
    for (const index of changed) {
      const entry = this.entries.get(index);
      if (entry) this.store.notifyTextBlock(entry);
    }
  }
}
