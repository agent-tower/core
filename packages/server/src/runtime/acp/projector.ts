import type { SessionNotification, SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk';
import {
  addNormalizedEntry,
  createAssistantMessage,
  createErrorMessage,
  createThinking,
  createTokenUsageInfo,
  createToolUse,
  createWarningMessage,
  replaceNormalizedEntry,
  type ActionType,
  type MsgStore,
  type NormalizedEntry,
  type ToolContent,
  type ToolLocation,
  type ToolStatus,
  type TodoItem,
  updateEntryContent,
} from '../../output/index.js';
import type { RuntimeDriverEventSink } from '../contracts.js';
import { randomUUID } from 'node:crypto';

const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_TOOL_OUTPUT_LENGTH = 32 * 1024;
const TOOL_OUTPUT_HEAD_LENGTH = 24 * 1024;
const TOOL_OUTPUT_TRUNCATED_MARKER = '\n[TRUNCATED]\n';

interface StreamingEntry {
  index: number;
  content: string;
}

interface ProjectedTool {
  index?: number;
  timestamp: number;
  toolId: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: ToolContent[];
  locations?: ToolLocation[];
  inputSummary?: string;
  outputSummary?: string;
  terminalOutput?: BoundedTextPreview;
}

interface BoundedTextPreview {
  head: string;
  tail: string;
  truncated: boolean;
}

export class AcpProjector {
  private readonly messages = new Map<string, StreamingEntry>();
  private readonly tools = new Map<string, ProjectedTool>();
  private planIndex?: number;
  private usageIndex?: number;
  private segments = new Map<string, { role: string; rawId: string | undefined; key: string; identity?: NonNullable<NormalizedEntry['metadata']>['acpTextIdentity'] }>();
  private streamId = 'main';
  private nativeSessionId = '';

  constructor(
    private readonly msgStore: MsgStore,
    private readonly sink: RuntimeDriverEventSink,
  ) {}

  project(notification: SessionNotification): void {
    const update = notification.update as SessionUpdate & Record<string, unknown>;
    const parent = asRecord(asRecord(update._meta)?.claudeCode)?.parentToolUseId;
    const stream = typeof parent === 'string' ? parent : 'main';
    this.streamId = stream;
    this.nativeSessionId = notification.sessionId;
    this.msgStore.textBlocks.inStream(stream, () => this.projectUpdate(update));
  }

  private projectUpdate(update: SessionUpdate & Record<string, unknown>): void {
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        // A loaded user turn separates every stream, just as a fresh live
        // Projector does. A child-local user update only separates that child.
        if (this.streamId === 'main') {
          for (const streamId of this.segments.keys()) this.endSegment(streamId);
        } else this.endSegment();
        this.sink.stream({ type: 'progress' });
        break;
      case 'agent_message_chunk':
        this.projectContent(update, 'assistant');
        break;
      case 'agent_thought_chunk':
        this.projectContent(update, 'thought');
        break;
      case 'tool_call':
      case 'tool_call_update':
        this.endSegment();
        this.projectTool(update as ToolCallUpdate & Record<string, unknown>);
        break;
      case 'plan':
      case 'plan_update':
      case 'plan_removed':
        this.endSegment();
        this.projectPlan(update);
        break;
      case 'usage_update':
        this.projectUsage(update);
        break;
      default:
        this.sink.stream({ type: 'progress' });
    }
  }

  projectError(error: unknown): void {
    const message = sanitizeText(error instanceof Error ? error.message : String(error));
    const entry = createErrorMessage(message || 'ACP turn failed', message);
    const index = this.msgStore.entryIndex.next();
    this.pushPatch(addNormalizedEntry(index, entry));
  }

  private projectContent(update: Record<string, unknown>, role: 'assistant' | 'thought'): void {
    const content = asRecord(update.content);
    if (content?.type !== 'text' || typeof content.text !== 'string') { this.endSegment(); return; }
    const nativeId = typeof update.messageId === 'string' ? update.messageId : undefined;
    const rawId = nativeId;
    const discrete = asRecord(update._meta)?.qwenDiscreteMessage === true;
    let segment = this.segments.get(this.streamId);
    if (!segment || segment.role !== role || segment.rawId !== rawId || discrete) {
      this.endSegment();
      // Native message identity survives load; repeated contiguous segments (and
      // reused IDs across turns) are matched by ordered occurrence in the reconciler.
      const identity = nativeId === undefined ? undefined : { sessionId: this.nativeSessionId, streamId: this.streamId, messageId: nativeId };
      segment = { role, rawId, key: randomUUID(), identity };
      this.segments.set(this.streamId, segment);
    }
    const key = segment.key;
    const text = sanitizeText(content.text);
    const existing = this.messages.get(key);
    if (existing) {
      existing.content = sanitizeText(`${existing.content}${text}`);
      this.pushPatch(updateEntryContent(existing.index, existing.content));
      return;
    }
    const entry = role === 'assistant'
      ? createAssistantMessage(text)
      : createThinking(text);
    if (segment.identity) entry.metadata = { ...entry.metadata, acpTextIdentity: segment.identity };
    const index = this.msgStore.entryIndex.next();
    this.messages.set(key, { index, content: text });
    this.pushPatch(addNormalizedEntry(index, entry));
    if (discrete && role === 'assistant') { this.msgStore.textBlocks.complete(index); this.segments.delete(this.streamId); }
  }

  private endSegment(streamId = this.streamId): void {
    this.msgStore.textBlocks.boundary(streamId);
    this.segments.delete(streamId);
  }

  private projectTool(update: ToolCallUpdate & Record<string, unknown>): void {
    const toolId = typeof update.toolCallId === 'string' ? update.toolCallId : 'unknown';
    const existing = this.tools.get(toolId);
    const tool = existing ?? {
      timestamp: Date.now(),
      toolId,
    };
    mergeToolUpdate(tool, update);

    if (isMcpStartupDiagnostic(tool)) {
      this.tools.set(toolId, tool);
      if (tool.status !== 'failed') return;

      const message = summarizeMcpStartupDiagnostic(tool);
      const base = createWarningMessage(message, message, opaqueId('diagnostic', toolId));
      this.upsertToolEntry(tool, { ...base, timestamp: tool.timestamp });
      return;
    }

    const title = tool.title || tool.kind || 'Tool call';
    const kind = tool.kind || 'other';
    const content = summarizeTool(tool, title);
    const outputSummary = resolveToolOutputSummary(tool);
    const base = createToolUse(title, content, toolAction(kind), toolId, opaqueId('tool', toolId));
    const entry: NormalizedEntry = {
      ...base,
      timestamp: tool.timestamp,
      metadata: {
        ...base.metadata,
        toolKind: kind,
        status: mapToolStatus(tool.status),
        ...(tool.content ? { toolContent: tool.content } : {}),
        ...(tool.locations ? { toolLocations: tool.locations } : {}),
        ...(tool.inputSummary !== undefined ? { toolInputSummary: tool.inputSummary } : {}),
        ...(outputSummary !== undefined ? { toolOutputSummary: outputSummary } : {}),
      },
    };
    this.tools.set(toolId, tool);
    this.upsertToolEntry(tool, entry);
  }

  private upsertToolEntry(tool: ProjectedTool, entry: NormalizedEntry): void {
    if (tool.index !== undefined) {
      this.pushPatch(replaceNormalizedEntry(tool.index, entry));
      return;
    }
    tool.index = this.msgStore.entryIndex.next();
    this.pushPatch(addNormalizedEntry(tool.index, entry));
  }

  private projectPlan(update: Record<string, unknown>): void {
    const entries = Array.isArray(update.entries) ? update.entries : [];
    const todos: TodoItem[] = entries.slice(0, 100).flatMap((value) => {
      const item = asRecord(value);
      if (!item || typeof item.content !== 'string') return [];
      const todo: TodoItem = {
        content: sanitizeText(item.content),
        status: typeof item.status === 'string' ? item.status : 'pending',
      };
      if (typeof item.priority === 'string') todo.priority = item.priority;
      return [todo];
    });
    const content = todos.map((todo) => todo.content).join('\n') || 'Plan updated';
    const base = createToolUse('plan', content, 'todo_management', 'acp-plan', 'acp-plan', {
      todos,
      todoOperation: 'update',
    });
    const entry: NormalizedEntry = {
      ...base,
      metadata: { ...base.metadata, status: 'success' },
    };
    if (this.planIndex !== undefined) {
      this.pushPatch(replaceNormalizedEntry(this.planIndex, entry));
      return;
    }
    this.planIndex = this.msgStore.entryIndex.next();
    this.pushPatch(addNormalizedEntry(this.planIndex, entry));
  }

  private projectUsage(update: Record<string, unknown>): void {
    const used = safeInteger(update.used);
    const size = safeInteger(update.size);
    if (used === undefined) return;
    const entry = createTokenUsageInfo(used, size, 'acp-usage');
    if (this.usageIndex !== undefined) {
      this.pushPatch(replaceNormalizedEntry(this.usageIndex, entry));
      return;
    }
    this.usageIndex = this.msgStore.entryIndex.next();
    this.pushPatch(addNormalizedEntry(this.usageIndex, entry));
  }

  private pushPatch(patch: Parameters<MsgStore['pushPatch']>[0]): void {
    const seq = this.msgStore.pushPatch(patch);
    this.sink.stream({ type: 'conversation_patch', patch, seq });
  }
}

function mergeToolUpdate(tool: ProjectedTool, update: Record<string, unknown>): void {
  let replacedTerminalOutput = false;
  if (hasOwn(update, 'title')) {
    tool.title = typeof update.title === 'string' ? sanitizeText(update.title, 4_096) : undefined;
  }
  if (hasOwn(update, 'kind')) {
    tool.kind = typeof update.kind === 'string' ? sanitizeText(update.kind, 128) : undefined;
  }
  if (hasOwn(update, 'status')) {
    tool.status = typeof update.status === 'string' ? update.status : undefined;
  }
  if (hasOwn(update, 'content')) {
    tool.content = Array.isArray(update.content)
      ? update.content.slice(0, 32).map(mapToolContent)
      : undefined;
  }
  if (hasOwn(update, 'locations')) {
    tool.locations = Array.isArray(update.locations)
      ? update.locations.slice(0, 32).flatMap(mapToolLocation)
      : undefined;
  }
  if (hasOwn(update, 'rawInput') && update.rawInput !== undefined) {
    tool.inputSummary = update.rawInput === null ? undefined : safeSummary(update.rawInput);
  }
  if (hasOwn(update, 'rawOutput') && update.rawOutput !== undefined) {
    if (update.rawOutput === null) {
      tool.outputSummary = undefined;
      tool.terminalOutput = undefined;
    } else {
      const formattedOutput = asRecord(update.rawOutput)?.formatted_output;
      if (typeof formattedOutput === 'string') {
        tool.outputSummary = undefined;
        tool.terminalOutput = appendBoundedPreview(undefined, formattedOutput);
        replacedTerminalOutput = true;
      } else {
        tool.terminalOutput = undefined;
        tool.outputSummary = safeSummary(update.rawOutput);
      }
    }
  }
  const terminalDelta = readTerminalOutput(update);
  if (terminalDelta !== undefined && !replacedTerminalOutput) {
    tool.terminalOutput = appendBoundedPreview(tool.terminalOutput, terminalDelta);
  }
}

function summarizeTool(tool: ProjectedTool, fallback: string): string {
  const parts: string[] = [];
  if (tool.inputSummary) parts.push(`Input\n${tool.inputSummary}`);
  const outputSummary = resolveToolOutputSummary(tool);
  if (outputSummary) parts.push(`Output\n${outputSummary}`);
  const content = tool.content?.map(summarizeToolContent).filter(Boolean).join('\n');
  if (content) parts.push(`Content\n${content}`);
  const locations = tool.locations?.map((location) => (
    location.line === undefined ? location.path : `${location.path}:${location.line}`
  )).join('\n');
  if (locations) parts.push(`Locations\n${locations}`);
  return sanitizeText(parts.join('\n\n') || fallback);
}

function isMcpStartupDiagnostic(tool: ProjectedTool): boolean {
  return tool.toolId.startsWith('mcp_startup.');
}

function summarizeMcpStartupDiagnostic(tool: ProjectedTool): string {
  const detail = tool.content?.find((content) => content.type === 'text');
  const message = detail?.type === 'text'
    ? detail.text
    : tool.outputSummary || tool.title || 'MCP server failed to start';
  return sanitizeText(message.replace(/^\[codex-acp forwarded startup error\]\s*/i, ''));
}

function safeSummary(value: unknown): string {
  try {
    return sanitizeText(typeof value === 'string' ? value : JSON.stringify(value), MAX_TOOL_OUTPUT_LENGTH);
  } catch {
    return '[Unsupported tool data]';
  }
}

function resolveToolOutputSummary(tool: ProjectedTool): string | undefined {
  if (!tool.terminalOutput) return tool.outputSummary;
  return tool.terminalOutput.truncated
    ? `${tool.terminalOutput.head}${TOOL_OUTPUT_TRUNCATED_MARKER}${tool.terminalOutput.tail}`
    : tool.terminalOutput.head;
}

function readTerminalOutput(update: Record<string, unknown>): string | undefined {
  const meta = asRecord(update._meta);
  for (const key of ['terminal_output_delta', 'terminal_output']) {
    const output = asRecord(meta?.[key]);
    if (typeof output?.data === 'string') return output.data;
  }
  return undefined;
}

function appendBoundedPreview(
  preview: BoundedTextPreview | undefined,
  next: string,
): BoundedTextPreview {
  const sanitized = sanitizeText(next, Number.MAX_SAFE_INTEGER);
  if (!preview) {
    if (sanitized.length <= MAX_TOOL_OUTPUT_LENGTH) {
      return { head: sanitized, tail: '', truncated: false };
    }
    return {
      head: sanitized.slice(0, TOOL_OUTPUT_HEAD_LENGTH),
      tail: sanitized.slice(-(MAX_TOOL_OUTPUT_LENGTH - TOOL_OUTPUT_HEAD_LENGTH - TOOL_OUTPUT_TRUNCATED_MARKER.length)),
      truncated: true,
    };
  }
  if (!preview.truncated && preview.head.length + sanitized.length <= MAX_TOOL_OUTPUT_LENGTH) {
    return { ...preview, head: `${preview.head}${sanitized}` };
  }
  const tailLength = MAX_TOOL_OUTPUT_LENGTH - TOOL_OUTPUT_HEAD_LENGTH - TOOL_OUTPUT_TRUNCATED_MARKER.length;
  const combined = preview.truncated
    ? `${preview.tail}${sanitized}`
    : `${preview.head}${sanitized}`;
  return {
    head: preview.truncated ? preview.head : combined.slice(0, TOOL_OUTPUT_HEAD_LENGTH),
    tail: combined.slice(-tailLength),
    truncated: true,
  };
}

function mapToolContent(value: unknown): ToolContent {
  const item = asRecord(value);
  if (!item || typeof item.type !== 'string') {
    return { type: 'unsupported', contentType: 'unknown' };
  }
  if (item.type === 'content') {
    const content = asRecord(item.content);
    if (content?.type === 'text' && typeof content.text === 'string') {
      return { type: 'text', text: sanitizeText(content.text, 16 * 1024) };
    }
    if (content?.type === 'resource_link' && typeof content.uri === 'string') {
      return {
        type: 'resource_link',
        uri: sanitizeText(content.uri, 4_096),
        ...(typeof content.name === 'string' ? { name: sanitizeText(content.name, 1_024) } : {}),
      };
    }
    if (content?.type === 'resource') {
      const resource = asRecord(content.resource);
      if (resource && typeof resource.text === 'string') {
        return { type: 'text', text: sanitizeText(resource.text, 16 * 1024) };
      }
    }
    return {
      type: 'unsupported',
      contentType: typeof content?.type === 'string' ? sanitizeText(content.type, 128) : 'content',
    };
  }
  if (item.type === 'diff' && typeof item.path === 'string' && typeof item.newText === 'string') {
    return {
      type: 'diff',
      path: sanitizeText(item.path, 4_096),
      ...(typeof item.oldText === 'string' ? { oldText: sanitizeText(item.oldText, 16 * 1024) } : {}),
      newText: sanitizeText(item.newText, 16 * 1024),
    };
  }
  if (item.type === 'terminal' && typeof item.terminalId === 'string') {
    return { type: 'terminal', terminalId: sanitizeText(item.terminalId, 1_024) };
  }
  return { type: 'unsupported', contentType: sanitizeText(item.type, 128) };
}

function summarizeToolContent(content: ToolContent): string {
  switch (content.type) {
    case 'text':
      return content.text;
    case 'resource_link':
      return content.name ? `${content.name}: ${content.uri}` : content.uri;
    case 'diff':
      return `${content.path}\n${content.newText}`;
    case 'terminal':
      return `Terminal: ${content.terminalId}`;
    case 'unsupported':
      return `[${content.contentType}]`;
  }
}

function mapToolLocation(value: unknown): ToolLocation[] {
  const location = asRecord(value);
  if (!location || typeof location.path !== 'string') return [];
  return [{
    path: sanitizeText(location.path, 4_096),
    ...(isUint32(location.line) ? { line: location.line } : {}),
  }];
}

function sanitizeText(value: string, maxLength = MAX_TEXT_LENGTH): string {
  const redacted = value
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\b(?:sk|key|token|secret)-[A-Za-z0-9._-]{8,}\b/gi, '[REDACTED]');
  return redacted.length > maxLength
    ? `${redacted.slice(0, maxLength)}\n[TRUNCATED]`
    : redacted;
}

function opaqueId(prefix: string, raw: string): string {
  return `acp-${prefix}-${Buffer.from(raw).toString('base64url').slice(0, 96)}`;
}

function mapToolStatus(status: unknown): ToolStatus {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'failed';
  if (status === 'pending') return 'pending';
  if (status === 'in_progress') return 'in_progress';
  return 'created';
}

function toolAction(kind: string): ActionType {
  const lower = kind.toLowerCase();
  if (lower.includes('read')) return 'file_read';
  if (lower.includes('edit') || lower.includes('write') || lower.includes('delete') || lower.includes('move')) return 'file_edit';
  if (lower.includes('terminal') || lower.includes('command') || lower.includes('execute')) return 'command_run';
  if (lower.includes('search')) return 'search';
  if (lower.includes('fetch')) return 'web_fetch';
  return 'tool';
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isUint32(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= 0xffff_ffff;
}
