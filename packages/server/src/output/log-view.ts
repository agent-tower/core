/**
 * Light log view: the same conversation without the bulky tool output that the
 * web client only shows after a tool item is expanded.
 *
 * Tool output is most of a log's size (85–90% in production logs) and every
 * open used to download all of it. The light view keeps the document shape —
 * every entry stays at its index, so live JSON patches still apply — and only
 * shortens the `content` of long `tool_use` entries to a prefix that holds the
 * tool's title line. `contentOmitted` records the full length; the client
 * loads the full text per entry when the user expands it.
 *
 * `metadata.toolContent` and `metadata.fileChanges` (ACP diffs, written file
 * bodies) are never read by the web client and are dropped from this view.
 */
import type { NormalizedConversation, NormalizedEntry } from './types.js';

/** Tool output longer than this many characters is shortened. */
export const LIGHT_TOOL_CONTENT_LIMIT = 1024;
/** Longest prefix kept for a shortened tool output. */
export const LIGHT_TOOL_PREVIEW_LIMIT = 600;

/**
 * The head of a tool output that identifies the call: its first paragraph
 * ("Reading /path", the command line, or an ACP "Input" block), bounded.
 * Always a prefix of `content`.
 */
export function toolContentPreview(content: string): string {
  const head = content.slice(0, LIGHT_TOOL_PREVIEW_LIMIT);
  // Leading blank lines are not the first paragraph.
  const start = head.search(/\S/);
  if (start < 0) return head;
  const paragraphEnd = head.indexOf('\n\n', start);
  if (paragraphEnd >= 0) return head.slice(0, paragraphEnd);
  if (content.length <= LIGHT_TOOL_PREVIEW_LIMIT) return head;
  const lineEnd = head.lastIndexOf('\n');
  return lineEnd > 0 ? head.slice(0, lineEnd) : head;
}

export function toLightEntry(entry: NormalizedEntry): NormalizedEntry {
  if (!entry || entry.entryType !== 'tool_use') return entry;
  const metadata = entry.metadata;
  const dropMetadata = metadata !== undefined
    && (metadata.toolContent !== undefined || metadata.fileChanges !== undefined);
  const omitContent = typeof entry.content === 'string' && entry.content.length > LIGHT_TOOL_CONTENT_LIMIT;
  if (!dropMetadata && !omitContent) return entry;

  // Never mutate: live entries are shared with the MsgStore snapshot cache.
  const light: NormalizedEntry = { ...entry };
  if (dropMetadata) {
    const { toolContent: _toolContent, fileChanges: _fileChanges, ...rest } = metadata;
    light.metadata = rest;
  }
  if (omitContent) {
    light.content = toolContentPreview(entry.content);
    light.contentOmitted = entry.content.length;
  }
  return light;
}

export function toLightConversation(conversation: NormalizedConversation): NormalizedConversation {
  const entries = Array.isArray(conversation.entries) ? conversation.entries : [];
  return { ...conversation, entries: entries.map(toLightEntry) };
}

/** Requested full tool outputs: entry ID plus the full length the light view reported. */
export interface LogEntryContentRequest {
  id: string;
  length?: number;
}

/** One answer per distinct request; `length` echoes the request so duplicate IDs stay apart. */
export interface LogEntryContent {
  id: string;
  length?: number;
  content: string;
}

/**
 * Finds the full content of the requested entries. Entry IDs are not unique
 * (151 of 7,652 entries in a production sample share an ID), so each request
 * takes the entry with its ID and the requested length, else the first entry
 * with that ID.
 */
export function findEntryContents(
  entries: readonly NormalizedEntry[],
  requests: readonly LogEntryContentRequest[],
): LogEntryContent[] {
  const ids = new Set(requests.map((request) => request.id));
  const candidates = new Map<string, NormalizedEntry[]>();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.content !== 'string' || !ids.has(entry.id)) continue;
    const list = candidates.get(entry.id);
    if (list) list.push(entry);
    else candidates.set(entry.id, [entry]);
  }
  const answered = new Set<string>();
  const results: LogEntryContent[] = [];
  for (const request of requests) {
    const key = `${request.id}:${request.length ?? ''}`;
    const list = candidates.get(request.id);
    if (!list || answered.has(key)) continue;
    answered.add(key);
    const entry = list.find((item) => item.content.length === request.length) ?? list[0];
    results.push(request.length === undefined
      ? { id: request.id, content: entry.content }
      : { id: request.id, length: request.length, content: entry.content });
  }
  return results;
}
