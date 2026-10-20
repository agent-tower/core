import type { MsgStore } from './msg-store.js';
import { createAssistantMessage, createErrorMessage, createWarningMessage, createTokenUsageInfo, createToolUse } from './types.js';
import { addNormalizedEntry, updateEntryContent, updateToolStatus } from './utils/patch.js';
import { stripAnsiSequences } from './utils/ansi.js';

/** Gemini CLI 0.27 stream-json: nonInteractiveCli + core/output/types. */
export class GeminiParser {
  private buffer = '';
  private current?: { index: number; text: string };
  private tools = new Map<string, { index: number; input: string }>();
  private terminal = false;
  private completed = new Set<() => void>();
  private failed = new Set<() => void>();
  constructor(private readonly store: MsgStore) {}
  onTurnCompleted(listener: () => void): () => void { this.completed.add(listener); return () => this.completed.delete(listener); }
  onTurnFailed(listener: () => void): () => void { this.failed.add(listener); return () => this.failed.delete(listener); }
  processData(data: string): void {
    this.buffer += stripAnsiSequences(data);
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }
  private line(line: string): void {
    let event: Record<string, any>;
    try { event = JSON.parse(line); } catch { return; }
    if (this.terminal) return;
    if (event.type === 'init' && typeof event.session_id === 'string') this.store.pushSessionId(event.session_id);
    else if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
      if (this.current) {
        this.current.text += event.content;
        this.store.pushPatch(updateEntryContent(this.current.index, this.current.text));
      } else {
        const index = this.store.entryIndex.next();
        this.current = { index, text: event.content };
        this.store.pushPatch(addNormalizedEntry(index, createAssistantMessage(event.content)));
      }
    } else if (event.type === 'tool_use' && typeof event.tool_id === 'string') {
      this.store.textBlocks.boundary();
      this.current = undefined;
      if (this.tools.has(event.tool_id)) return;
      const index = this.store.entryIndex.next();
      const input = JSON.stringify(event.parameters ?? {});
      this.tools.set(event.tool_id, { index, input });
      this.store.pushPatch(addNormalizedEntry(index, createToolUse(String(event.tool_name ?? 'tool'), input, 'tool', event.tool_id)));
    } else if (event.type === 'tool_result' && typeof event.tool_id === 'string') {
      this.store.textBlocks.boundary();
      this.current = undefined;
      const tool = this.tools.get(event.tool_id);
      if (tool) {
        const output = String(event.output ?? event.error?.message ?? '').slice(0, 32 * 1024);
        this.store.pushPatch(updateToolStatus(tool.index, event.status === 'error' ? 'failed' : 'success'));
        if (output) this.store.pushPatch(updateEntryContent(tool.index, `${tool.input}\n\nOutput:\n${output}`));
      }
    } else if (event.type === 'error' && typeof event.message === 'string') {
      this.store.textBlocks.boundary(); this.current = undefined;
      this.store.pushPatch(addNormalizedEntry(this.store.entryIndex.next(), event.severity === 'warning' ? createWarningMessage(event.message) : createErrorMessage(event.message)));
    } else if (event.type === 'result' && ['success', 'error'].includes(event.status)) {
      this.terminal = true;
      if (Number.isFinite(event.stats?.total_tokens)) this.store.pushPatch(addNormalizedEntry(this.store.entryIndex.next(), createTokenUsageInfo(event.stats.total_tokens)));
      if (event.status === 'error') {
        this.store.pushPatch(addNormalizedEntry(this.store.entryIndex.next(), createErrorMessage(String(event.error?.message ?? 'Gemini turn failed'))));
        for (const listener of this.failed) listener();
      } else for (const listener of this.completed) listener();
    }
  }
  finish(): void { if (this.buffer.trim()) this.line(this.buffer); this.buffer = ''; }
}
