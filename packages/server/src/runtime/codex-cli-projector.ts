import type { MsgStore } from '../output/msg-store.js';
import { createAssistantMessage, createThinking, createToolUse, createErrorMessage, createTokenUsageInfo, type NormalizedEntry, type ToolStatus } from '../output/types.js';
import { addNormalizedEntry, replaceNormalizedEntry } from '../output/utils/patch.js';

type Item = Record<string, any>;
const MAX_OUTPUT_LENGTH = 32 * 1024;
const MAX_TEXT_LENGTH = 64 * 1024;
function boundedPreview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = '\n[TRUNCATED]\n';
  const head = Math.floor(limit * 3 / 4);
  return text.slice(0, head) + marker + text.slice(-(limit - head - marker.length));
}
/** Native v2 events only; never publish raw RPC requests or replay resumed history. */
export class CodexCliProjector {
  private readonly entries = new Map<string, { index: number; entry: NormalizedEntry; output?: string }>();
  constructor(private readonly store: MsgStore) {}
  thread(id: string) { this.store.pushSessionId(id); }
  usage(usage?: Item) {
    if (usage && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)) this.put('usage', createTokenUsageInfo(usage.inputTokens + usage.outputTokens));
  }
  error(message: string) { this.put('error', createErrorMessage(message)); }
  item(item: Item, completed = false) {
    if (typeof item.id !== 'string') return;
    const status: ToolStatus = item.status === 'declined' ? 'denied' : item.status === 'failed' || item.error ? 'failed'
      : item.status === 'completed' ? 'success' : 'in_progress';
    if (item.type === 'agentMessage') this.put(item.id, createAssistantMessage(typeof item.text === 'string' ? item.text : '', item.id));
    else if (item.type === 'reasoning') this.put(item.id, createThinking([...(item.summary ?? []), ...(item.content ?? [])].filter(v => typeof v === 'string').join('\n'), item.id));
    else if (item.type === 'commandExecution') {
      const entry = createToolUse('bash', typeof item.command === 'string' ? item.command : 'Command', 'command_run', item.id, item.id);
      const output = boundedPreview(typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : this.entries.get(item.id)?.output ?? '', MAX_OUTPUT_LENGTH);
      this.put(item.id, { ...entry, metadata: { ...entry.metadata, status }, content: output ? `${entry.content}\n\nOutput:\n${output}` : entry.content }, output);
    } else if (item.type === 'fileChange') {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const entry = createToolUse('apply_patch', changes.map((c: Item) => c.path).join('\n') || 'File changes', 'file_edit', item.id, item.id);
      this.put(item.id, { ...entry, metadata: { ...entry.metadata, status, fileChanges: changes.filter((c: Item) => typeof c.path === 'string').map((c: Item) => ({
        type: c.kind?.type === 'add' ? 'write' : c.kind?.type === 'delete' ? 'delete' : 'edit', path: c.path,
      })) } });
    } else if (item.type === 'mcpToolCall') {
      const entry = createToolUse(String(item.tool ?? 'mcp'), `${item.server}/${item.tool}\n${JSON.stringify(item.arguments ?? {})}\n${JSON.stringify(item.result ?? item.error ?? '')}`, 'tool', item.id, item.id);
      this.put(item.id, { ...entry, metadata: { ...entry.metadata, status } });
    } else if (item.type === 'plan') this.put(item.id, createToolUse('plan', String(item.text ?? ''), 'plan_presentation', item.id));
    if (completed && item.type === 'agentMessage') this.store.textBlocks.complete(this.entries.get(item.id)!.index);
  }
  delta(method: string, itemId: string, delta: string) {
    const previous = this.entries.get(itemId); if (!previous) return;
    if (method === 'item/commandExecution/outputDelta') {
      const output = boundedPreview((previous.output ?? '') + delta, MAX_OUTPUT_LENGTH);
      const command = previous.entry.content.split('\n\nOutput:\n')[0];
      this.put(itemId, { ...previous.entry, content: `${command}\n\nOutput:\n${output}` }, output);
    } else this.put(itemId, { ...previous.entry, content: previous.entry.content + delta });
  }
  plan(plan: Item[]) {
    const todos = plan.map(p => ({ content: String(p.step ?? ''), status: p.status === 'completed' ? 'completed' as const : p.status === 'inProgress' ? 'in_progress' as const : 'pending' as const }));
    const entry = createToolUse('update_plan', todos.map(t => `${t.status}: ${t.content}`).join('\n'), 'todo_management', 'codex-plan');
    this.put('codex-plan', { ...entry, metadata: { ...entry.metadata, todos } });
  }
  private put(id: string, entry: NormalizedEntry, output?: string) {
    const previous = this.entries.get(id);
    if (previous) entry = { ...entry, id: previous.entry.id, timestamp: previous.entry.timestamp };
    entry = { ...entry, content: boundedPreview(entry.content, MAX_TEXT_LENGTH) };
    const index = previous?.index ?? this.store.entryIndex.next();
    this.entries.set(id, { index, entry, output });
    this.store.pushPatch(previous ? replaceNormalizedEntry(index, entry) : addNormalizedEntry(index, entry));
  }
}
