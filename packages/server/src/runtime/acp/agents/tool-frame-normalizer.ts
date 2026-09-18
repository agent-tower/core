const MAX_RAW_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 32 * 1024;
const MAX_INLINE_BINARY_CHARS = 4 * 1024;
const MAX_TERMINAL_DELTA_CHARS = 32 * 1024;
const MAX_TOOL_META_PREVIEW_CHARS = 64 * 1024;
const TRUNCATED_MARKER = '\n[TRUNCATED]\n';
const TERMINAL_META_KEYS = [
  'terminal_output_delta',
  'terminal_output',
  'terminal_exit',
  'terminal_info',
] as const;

/**
 * Raw NDJSON frame budget for adapters that report tool results inline.
 *
 * Those results carry base64 image reads, which inflates the payload by roughly
 * a third, so the shared 1 MiB default would reject any image above ~768 KiB
 * before {@link normalizeAcpToolFrame} ever gets to bound it. The budget bounds
 * what the transport is willing to buffer; the normalizer keeps ordinary frames
 * far below it.
 */
export const acpMaxStdoutFrameBytes = MAX_RAW_FRAME_BYTES;

/**
 * Bounds untrusted Agent tool payloads before they reach the shared ACP SDK.
 *
 * An ACP adapter that reports results inline can emit a single NDJSON frame
 * carrying an entire base64 file read, and the frame budget alone only turns
 * that into a fatal `protocol_violation`. Bounding the tool payload here instead
 * keeps the frame small and the session alive; everything dropped is either
 * re-readable or already discarded by `AcpProjector` (binary tool content is
 * projected as `unsupported`).
 *
 * Covers both places an adapter can repeat a tool call: `session/update`
 * (`tool_call` / `tool_call_update`) and `session/request_permission`.
 */
export function normalizeAcpToolFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const tool = resolveToolPayload(frame);
  if (tool) boundToolPayload(tool);
  return frame;
}

function resolveToolPayload(frame: Record<string, unknown>): Record<string, unknown> | undefined {
  const params = asRecord(frame.params);
  if (frame.method === 'session/update') {
    const update = asRecord(params?.update);
    return update && isToolUpdate(update.sessionUpdate) ? update : undefined;
  }
  if (frame.method === 'session/request_permission') {
    return asRecord(params?.toolCall);
  }
  return undefined;
}

function isToolUpdate(value: unknown): boolean {
  return value === 'tool_call' || value === 'tool_call_update';
}

function boundToolPayload(update: Record<string, unknown>): void {
  boundStringField(update, 'title', 4_096);
  boundStringField(update, 'toolCallId', 4_096);
  boundOpaqueField(update, 'rawInput', MAX_TOOL_OUTPUT_PREVIEW_CHARS);

  const rawOutput = asRecord(update.rawOutput);
  const formattedOutput = rawOutput?.formatted_output;
  if (typeof formattedOutput === 'string') {
    update.rawOutput = {
      formatted_output: boundedPreview(formattedOutput, MAX_TOOL_OUTPUT_PREVIEW_CHARS),
      ...(typeof rawOutput?.exit_code === 'number' ? { exit_code: rawOutput.exit_code } : {}),
    };
  } else {
    boundOpaqueField(update, 'rawOutput', MAX_TOOL_OUTPUT_PREVIEW_CHARS);
  }

  if (Array.isArray(update.content)) update.content = boundToolContent(update.content);
  boundOpaqueField(update, 'locations', MAX_TOOL_OUTPUT_PREVIEW_CHARS);

  const meta = asRecord(update._meta);
  if (!meta) return;
  for (const key of ['terminal_output_delta', 'terminal_output'] as const) {
    const terminalOutput = asRecord(meta[key]);
    if (!terminalOutput) continue;
    boundStringField(terminalOutput, 'terminal_id', 4_096);
    if (typeof terminalOutput.data !== 'string') continue;

    if (isTerminalStatus(update.status) && typeof formattedOutput === 'string') {
      delete meta[key];
      continue;
    }
    terminalOutput.data = boundedPreview(terminalOutput.data, MAX_TERMINAL_DELTA_CHARS);
  }
  boundToolMeta(update, meta);
}

function isTerminalStatus(value: unknown): boolean {
  return value === 'completed' || value === 'failed';
}

/**
 * Keeps every tool content entry schema-valid while bounding the whole array.
 *
 * An oversized entry cannot be replaced by the bare preview object: the entry
 * would no longer match `ToolCallContent` and the SDK schema would silently drop
 * it. Wrapping the preview in a text block keeps the payload, and binary entries
 * collapse to a placeholder because a truncated base64 body is unusable anyway.
 */
function boundToolContent(content: unknown[]): unknown[] {
  const normalized = content.map(boundToolContentEntry);
  const bounded = boundedOpaqueValue(normalized, MAX_TOOL_OUTPUT_PREVIEW_CHARS);
  if (bounded !== normalized) return [asTextToolContent(JSON.stringify(bounded))];
  return normalized;
}

function boundToolContentEntry(value: unknown): unknown {
  const content = asRecord(asRecord(value)?.content);
  if (typeof content?.data === 'string' && content.data.length > MAX_INLINE_BINARY_CHARS) {
    const omitted = describeOmittedBinary(content);
    if (omitted) return asTextToolContent(omitted);
  }
  const bounded = boundedOpaqueValue(value, MAX_TOOL_OUTPUT_PREVIEW_CHARS);
  return bounded === value ? value : asTextToolContent(JSON.stringify(bounded));
}

function asTextToolContent(text: string): Record<string, unknown> {
  return { type: 'content', content: { type: 'text', text } };
}

/**
 * A truncated base64 body is worthless, so report what was dropped instead. The
 * projector maps binary content to `unsupported` regardless, which makes the
 * placeholder the only part a client could ever display.
 */
function describeOmittedBinary(content: Record<string, unknown> | undefined): string | undefined {
  if (!content || typeof content.data !== 'string') return undefined;
  if (content.type !== 'image' && content.type !== 'audio') return undefined;
  const mimeType = typeof content.mimeType === 'string' ? content.mimeType : content.type;
  // `data` is base64, so the represented payload is about three quarters of it.
  const bytes = Math.floor(content.data.length * 3 / 4);
  return `[${content.type} omitted: ${mimeType}, ${describeBytes(bytes)}]`;
}

function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function boundedPreview(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const available = maxLength - TRUNCATED_MARKER.length;
  const headLength = Math.floor(available * 0.75);
  const tailLength = available - headLength;
  return `${value.slice(0, headLength)}${TRUNCATED_MARKER}${value.slice(-tailLength)}`;
}

function boundStringField(
  target: Record<string, unknown>,
  key: string,
  maxLength: number,
): void {
  const value = target[key];
  if (typeof value === 'string') target[key] = boundedPreview(value, maxLength);
}

function boundOpaqueField(
  target: Record<string, unknown>,
  key: string,
  maxLength: number,
): void {
  if (!Object.prototype.hasOwnProperty.call(target, key)) return;
  target[key] = boundedOpaqueValue(target[key], maxLength);
}

function boundToolMeta(update: Record<string, unknown>, meta: Record<string, unknown>): void {
  if (boundedOpaqueValue(meta, MAX_TOOL_META_PREVIEW_CHARS) === meta) return;
  const boundedMeta: Record<string, unknown> = { _truncated: true };
  for (const key of TERMINAL_META_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(meta, key)) continue;
    boundedMeta[key] = boundedOpaqueValue(
      meta[key],
      key === 'terminal_output_delta' || key === 'terminal_output'
        ? 256 * 1024
        : 4_096,
    );
  }
  update._meta = boundedMeta;
}

function boundedOpaqueValue(value: unknown, maxLength: number): unknown {
  if (typeof value === 'string') return boundedPreview(value, maxLength);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length <= maxLength) return value;
  return {
    _truncated: true,
    preview: boundedPreview(serialized, maxLength),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
