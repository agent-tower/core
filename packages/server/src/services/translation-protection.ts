import { randomBytes } from 'node:crypto';
import { TranslationError } from './translation-errors.js';

export const TRANSLATION_PROTECTION_VERSION = 2;
export const MAX_TRANSLATION_BLOCK_BYTES = 64 * 1024;
export const MAX_TRANSLATION_SEGMENT_BYTES = 4 * 1024;
export const MAX_TRANSLATION_SEGMENTS = 16;

export type TranslationTemplateToken =
  | { type: 'literal'; value: string }
  | { type: 'variable'; name: 'text' | 'target_language' };

/** Parse first, then interpolate: user text can never introduce another substitution. */
export function parseTranslationTemplate(template: string): TranslationTemplateToken[] {
  const tokens: TranslationTemplateToken[] = [];
  const variables = new Set<string>();
  let cursor = 0;
  for (const match of template.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const literal = template.slice(cursor, match.index);
    if (literal.includes('{{') || literal.includes('}}')) throw new TranslationError('INVALID_TEMPLATE');
    if (literal) tokens.push({ type: 'literal', value: literal });
    const name = match[1]!.trim();
    if (name !== 'text' && name !== 'target_language') throw new TranslationError('INVALID_TEMPLATE');
    tokens.push({ type: 'variable', name });
    variables.add(name);
    cursor = match.index! + match[0].length;
  }
  const tail = template.slice(cursor);
  if (tail.includes('{{') || tail.includes('}}') || variables.size !== 2) {
    throw new TranslationError('INVALID_TEMPLATE');
  }
  if (tail) tokens.push({ type: 'literal', value: tail });
  return tokens;
}

export function validateTranslationTemplate(template: string): void {
  parseTranslationTemplate(template);
}

export function renderTranslationTemplate(template: string, targetLanguage: string, text: string): string {
  return parseTranslationTemplate(template).map((token) => token.type === 'literal'
    ? token.value
    : token.name === 'text' ? text : targetLanguage).join('');
}

interface Piece { value: string; protected: boolean }
interface MaskedChunk { value: string; segmentIndex?: number }

export interface PreparedTranslation {
  /** Each entry is one request; only this masked text may leave the server. */
  segments: string[];
  hasTranslatableText: boolean;
  restore(translatedSegments: string[]): string;
}

const HAS_LANGUAGE = /\p{L}/u;
const TOKEN_PATTERN = /⟦AT_[a-f0-9]{24}_\d+⟧/g;
const VOID_HTML_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function addPiece(pieces: Piece[], value: string, protectedValue: boolean): void {
  if (!value) return;
  const last = pieces.at(-1);
  if (last?.protected === protectedValue) last.value += value;
  else pieces.push({ value, protected: protectedValue });
}

/** Balanced inline Markdown, including escapes. Unknown/unclosed forms stay local. */
function balancedEnd(text: string, start: number, open: string, close: string, json = false): number | null {
  let depth = 0;
  let quote: string | undefined;
  let angle = false;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    const character = text[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (angle) {
      if (character === '>') angle = false;
      continue;
    }
    if ((json && character === '"') || (open === '(' && (character === '"' || character === "'")
      && (index === start + 1 || /\s/.test(text[index - 1]!)))) { quote = character; continue; }
    if (open === '(' && character === '<') { angle = true; continue; }
    if (text[index] === open) depth++;
    if (text[index] === close && --depth === 0) return index + 1;
  }
  return null;
}

function htmlEnd(text: string, start: number): number | null {
  const rest = text.slice(start);
  const autoLink = rest.match(/^<(?:[a-z][a-z0-9+.-]*:|[^\s<>@]+@)[^<>\r\n]*>/i);
  if (autoLink) return start + autoLink[0].length;
  if (rest.startsWith('<!--')) {
    const end = text.indexOf('-->', start + 4);
    return end === -1 ? text.length : end + 3;
  }
  if (/^<(?:!|\?)/.test(rest)) {
    const end = text.indexOf('>', start + 2);
    return end === -1 ? text.length : end + 1;
  }
  const tag = rest.match(/^<\/?([a-z][a-z0-9:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/i);
  if (!tag) return /^<\/?[a-z]/i.test(rest) ? text.length : null;
  const firstEnd = start + tag[0].length;
  const name = tag[1]!.toLowerCase();
  if (/^<\//.test(tag[0]) || /\/\s*>$/.test(tag[0]) || VOID_HTML_TAGS.has(name)) return firstEnd;
  // Treat a complete element (including its contents) as local, even across blank lines.
  const tags = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-z][a-z0-9:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  tags.lastIndex = firstEnd;
  let depth = 1;
  for (let nested = tags.exec(text); nested; nested = tags.exec(text)) {
    if (nested[0].startsWith('<!--')) continue;
    const nestedName = nested[2]!.toLowerCase();
    if (nestedName === name) {
      if (nested[1]) depth--;
      else if (!/\/\s*>$/.test(nested[0])) depth++;
    } else if (!nested[1] && /^(?:script|style|textarea|title|pre)$/.test(nestedName)) {
      const rawClose = new RegExp(`</${nestedName}\\s*>`, 'gi');
      rawClose.lastIndex = tags.lastIndex;
      const close = rawClose.exec(text);
      if (!close) return text.length;
      tags.lastIndex = rawClose.lastIndex;
    }
    if (depth === 0) return tags.lastIndex;
  }
  return text.length;
}

// These lexical forms are deliberately conservative and do not resolve resources.
function resourcePrefix(text: string): string | undefined {
  return text.match(/^(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|tel|data|file|attachment):)[^\s<>\[\]`]+/i)?.[0]
    ?? text.match(/^(?:www\.)[^\s<>\[\]`]+/i)?.[0]
    ?? text.match(/^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}/iu)?.[0]
    ?? text.match(/^(?:[a-z]:[\\/]|\\\\|\.{1,2}[\\/]|~[\\/]|\/)[^\s<>\[\]()`"']*/i)?.[0]
    ?? text.match(/^[\p{L}\p{N}_.@-]+(?:[\\/][\p{L}\p{N}_.@+-]+)+(?:[:#][\p{L}\p{N}:]+)?/u)?.[0]
    ?? text.match(/^[\p{L}\p{N}_-]+\.[a-z][a-z0-9]{0,15}(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?(?![\p{L}\p{N}_])/iu)?.[0];
}

function looksLikeCode(line: string): boolean {
  return /^\s*(?:(?:const|let|var|import|export|function|class|return|throw)\b.*[=;{}]|(?:if|for|while|switch)\s*\(|\$\s+\S|[A-Z_][A-Z0-9_]*=)/.test(line)
    || /(?:=>|===|!==)/.test(line)
    || /^\s*(?:[\w.$]+\(.*\)[;]?|(?:pnpm|npm|npx|git|node|python\d*|pip\d*|curl|wget|bash|sh|zsh|ls|cd|rm|mkdir)\s+\S.*)\s*$/.test(line);
}

function unclosedInlineCode(body: string): { index: number; marker: string } | null {
  for (let index = 0; index < body.length; index++) {
    if (body[index] === '\\') { index++; continue; }
    if (body[index] !== '`') continue;
    const marker = body.slice(index).match(/^`+/)![0];
    let end = body.indexOf(marker, index + marker.length);
    while (end !== -1 && (body[end - 1] === '`' || body[end + marker.length] === '`')) end = body.indexOf(marker, end + marker.length);
    if (end === -1) return { index, marker };
    index = end + marker.length - 1;
  }
  return null;
}

function scanInline(text: string, pieces: Piece[]): void {
  let position = 0;
  while (position < text.length) {
    const rest = text.slice(position);
    const character = text[position]!;
    if (character === '`') {
      const marker = rest.match(/^`+/)![0];
      let end = text.indexOf(marker, position + marker.length);
      while (end !== -1 && (text[end - 1] === '`' || text[end + marker.length] === '`')) {
        end = text.indexOf(marker, end + marker.length);
      }
      end = end === -1 ? text.length : end + marker.length;
      addPiece(pieces, text.slice(position, end), true); position = end; continue;
    }
    if (character === '<') {
      const end = htmlEnd(text, position);
      if (end !== null) {
        addPiece(pieces, text.slice(position, end), true); position = end; continue;
      }
      // Comparisons and unknown angle syntax must not be turned into a new tag
      // by translating only the characters between their delimiters.
      const close = text.indexOf('>', position + 1);
      const safeEnd = close === -1 ? text.length : close + 1;
      addPiece(pieces, text.slice(position, safeEnd), true); position = safeEnd; continue;
    }
    const originalToken = rest.match(/^⟦AT_[a-f0-9]{24}_\d+⟧/)?.[0];
    if (originalToken) { addPiece(pieces, originalToken, true); position += originalToken.length; continue; }
    if (rest.startsWith('::') && /^::[a-z-]/i.test(rest)) {
      addPiece(pieces, rest, true); return;
    }
    if (character === '@') {
      if (rest.startsWith('@[')) {
        const labelEnd = balancedEnd(text, position + 1, '[', ']');
        const targetEnd = labelEnd && text[labelEnd] === '(' ? balancedEnd(text, labelEnd, '(', ')') : labelEnd;
        const end = targetEnd ?? text.length;
        addPiece(pieces, text.slice(position, end), true); position = end; continue;
      }
      const mention = rest.match(/^@[^\s@.,!?;:，。！？；：、)\]}>"'”’）】》]+/u)?.[0];
      if (mention) { addPiece(pieces, mention, true); position += mention.length; continue; }
    }
    if (character === '[' || rest.startsWith('![')) {
      const image = character === '!';
      const labelStart = position + (image ? 1 : 0);
      const labelEnd = balancedEnd(text, labelStart, '[', ']');
      const next = labelEnd === null ? undefined : text[labelEnd];
      const targetEnd = labelEnd !== null && (next === '(' || next === '[')
        ? balancedEnd(text, labelEnd, next, next === '(' ? ')' : ']') : null;
      if (image || labelEnd === null || targetEnd === null || (next === '[' && targetEnd === labelEnd! + 2)) {
        // Shortcut/collapsed references use their label as identity, so keep it local too.
        const end = targetEnd ?? (next === '(' || next === '[' ? text.length : labelEnd ?? text.length);
        addPiece(pieces, text.slice(position, end), true); position = end; continue;
      }
      addPiece(pieces, '[', true);
      scanInline(text.slice(labelStart + 1, labelEnd - 1), pieces);
      addPiece(pieces, text.slice(labelEnd - 1, targetEnd), true);
      position = targetEnd; continue;
    }
    if ((character === '"' || character === "'") && resourcePrefix(rest.slice(1))) {
      let end = position + 1;
      for (; end < text.length; end++) {
        if (text[end] === '\\') { end++; continue; }
        if (text[end] === character) break;
      }
      if (end >= text.length) end = -1;
      if (end !== -1) {
        addPiece(pieces, text.slice(position, end + 1), true); position = end + 1; continue;
      }
      addPiece(pieces, rest, true); return;
    }
    // Only start a bare resource at a lexical boundary, never in the middle of a word.
    if (position === 0 || !/[\p{L}\p{N}_]/u.test(text[position - 1]!)) {
      const resource = resourcePrefix(rest);
      if (resource) { addPiece(pieces, resource, true); position += resource.length; continue; }
    }
    if (/^[\r\n\[\](){}<>`*_~#|\\!⟦⟧]/u.test(character)) {
      const end = character === '\\' ? Math.min(position + 2, text.length) : position + 1;
      addPiece(pieces, text.slice(position, end), true); position = end; continue;
    }
    const codePoint = String.fromCodePoint(text.codePointAt(position)!);
    addPiece(pieces, codePoint, false); position += codePoint.length;
  }
}

function scan(text: string, onParagraph?: (end: number) => void): Piece[] {
  const pieces: Piece[] = [];
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
  let fence: { character: string; length: number } | undefined;
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const body = line.replace(/[\r\n]+$/, '');
    const newline = line.slice(body.length);
    const marker = body.match(/^[ \t]*(?:(?:>|[-+*]|\d+[.)])[ \t]+)*(`{3,}|~{3,})/);
    if (fence) {
      addPiece(pieces, line, true);
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length
        && /^[ \t]*$/.test(body.slice(marker[0].length))) fence = undefined;
    } else if (marker) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length };
      addPiece(pieces, line, true);
    } else if (/^[ \t]{0,3}\[[^\]]+\]:/.test(body)) {
      let consumed = line.length;
      // A reference definition's optional quoted title can occupy the next line.
      if (index + 1 < lines.length && /^[ \t]*["'(]/.test(lines[index + 1]!)) {
        const titleStart = offset + consumed + lines[index + 1]!.search(/["'(]/);
        const opener = text[titleStart]!;
        const closer = opener === '(' ? ')' : opener;
        let close = text.indexOf(closer, titleStart + 1);
        while (close !== -1 && text[close - 1] === '\\') close = text.indexOf(closer, close + 1);
        const end = close === -1 ? text.length : close + 1;
        while (offset + consumed < end && index + 1 < lines.length) consumed += lines[++index]!.length;
      }
      addPiece(pieces, text.slice(offset, offset + consumed), true);
      offset += consumed;
      continue;
    } else if (/^(?: {4}|\t)/.test(body)
      || /^(?:[ \t]{0,3}>[ \t]?)+(?: {4}|\t)/.test(body)
      || /^[ \t]{0,3}(?:[-+*]|\d+[.)])(?: {5}|\t)/.test(body)
      || /^[ \t]*::/.test(body)
      || /^[ \t]*(?:[-*_][ \t]*){3,}$/.test(body)
      || /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/.test(body)
      || looksLikeCode(body)) {
      addPiece(pieces, line, true);
    } else {
      // Only this branch is outside fences and multiline code/HTML/link spans.
      if (!body.trim() && newline) onParagraph?.(offset + line.length);
      // Structured code without a fence and inline code spanning lines must also
      // remain local. If incomplete, conservatively retain the remaining block.
      const jsonStart = body.search(/\S/);
      const jsonCandidate = jsonStart !== -1 && /^(?:\{(?:\s|"|$)|\[(?:\s|[\[\]{}"\d-]|$))/.test(body.slice(jsonStart));
      if (jsonCandidate) {
        const start = offset + jsonStart;
        const open = text[start]!;
        const end = balancedEnd(text, start, open, open === '{' ? '}' : ']', true) ?? text.length;
        let consumed = line.length;
        while (offset + consumed < end && index + 1 < lines.length) consumed += lines[++index]!.length;
        addPiece(pieces, text.slice(offset, offset + consumed), true);
        offset += consumed;
        continue;
      }
      // HTML may extend beyond this line. Consume its entire matched element locally.
      let htmlStart = body.indexOf('<');
      let htmlStop: number | null = null;
      while (htmlStart !== -1) {
        htmlStop = htmlEnd(text, offset + htmlStart);
        if (htmlStop !== null && htmlStop > offset + body.length) break;
        // A short tag or a complete same-line element must not hide the next
        // element. Skip its contents, then inspect every remaining HTML start.
        htmlStart = body.indexOf('<', htmlStop === null ? htmlStart + 1 : htmlStop - offset);
      }
      if (htmlStop !== null && htmlStop > offset + body.length) {
        scanInline(body.slice(0, htmlStart), pieces);
        let consumed = line.length;
        while (offset + consumed < htmlStop && index + 1 < lines.length) consumed += lines[++index]!.length;
        addPiece(pieces, text.slice(offset + htmlStart, offset + consumed), true);
        offset += consumed;
        continue;
      }
      const codeSpill = unclosedInlineCode(body);
      if (codeSpill) {
        scanInline(body.slice(0, codeSpill.index), pieces);
        const codeStart = offset + codeSpill.index;
        let codeEnd = text.indexOf(codeSpill.marker, codeStart + codeSpill.marker.length);
        while (codeEnd !== -1 && (text[codeEnd - 1] === '`' || text[codeEnd + codeSpill.marker.length] === '`')) {
          codeEnd = text.indexOf(codeSpill.marker, codeEnd + codeSpill.marker.length);
        }
        const end = codeEnd === -1 ? text.length : codeEnd + codeSpill.marker.length;
        let consumed = line.length;
        while (offset + consumed < end && index + 1 < lines.length) consumed += lines[++index]!.length;
        addPiece(pieces, text.slice(codeStart, offset + consumed), true);
        offset += consumed;
        continue;
      }
      let linkSpill: number | undefined;
      for (let bracket = body.indexOf('['); bracket !== -1; bracket = body.indexOf('[', bracket + 1)) {
        if (bracket > 0 && body[bracket - 1] === '\\') continue;
        const labelEnd = balancedEnd(body, bracket, '[', ']');
        if (labelEnd === null || ((body[labelEnd] === '(' || body[labelEnd] === '[')
          && balancedEnd(body, labelEnd, body[labelEnd]!, body[labelEnd] === '(' ? ')' : ']') === null)) {
          linkSpill = bracket > 0 && (body[bracket - 1] === '!' || body[bracket - 1] === '@') ? bracket - 1 : bracket;
          break;
        }
      }
      if (linkSpill !== undefined) {
        scanInline(body.slice(0, linkSpill), pieces);
        const start = offset + linkSpill;
        const bracket = text[start] === '[' ? start : start + 1;
        const labelEnd = balancedEnd(text, bracket, '[', ']');
        const next = labelEnd === null ? undefined : text[labelEnd];
        const end = labelEnd !== null && (next === '(' || next === '[')
          ? balancedEnd(text, labelEnd, next, next === '(' ? ')' : ']') ?? text.length
          : labelEnd ?? text.length;
        let consumed = line.length;
        while (offset + consumed < end && index + 1 < lines.length) consumed += lines[++index]!.length;
        addPiece(pieces, text.slice(start, offset + consumed), true);
        offset += consumed;
        continue;
      }
      const prefix = body.match(/^[ \t]*(?:(?:>[ \t]*|#{1,6}[ \t]+|[-+*][ \t]+|\d+[.)][ \t]+|\[[ xX]\][ \t]+))*/)?.[0] ?? '';
      const suffix = body.slice(prefix.length).match(/[ \t]+$/)?.[0] ?? '';
      addPiece(pieces, prefix, true);
      scanInline(body.slice(prefix.length, body.length - suffix.length), pieces);
      addPiece(pieces, suffix + newline, true);
    }
    offset += line.length;
  }
  return pieces;
}

/** Keep short adjacent paragraphs together; never cut a protected multiline construct. */
export function findTranslationParagraphEnds(text: string): number[] {
  const ends: number[] = [];
  scan(text, end => {
    if (end - (ends.at(-1) ?? 0) >= 240 && text.slice(ends.at(-1) ?? 0, end).trim()) ends.push(end);
  });
  return ends;
}

/**
 * No content classified as protected is included in segments. The mapping and all
 * Markdown/resource bytes remain in this closure, never in persisted job metadata.
 */
export function prepareTranslation(text: string): PreparedTranslation {
  if (Buffer.byteLength(text, 'utf8') > MAX_TRANSLATION_BLOCK_BYTES) throw new TranslationError('PAYLOAD_TOO_LARGE');
  const pieces = scan(text);
  if (!pieces.some((piece) => !piece.protected && HAS_LANGUAGE.test(piece.value))) {
    return { segments: [], hasTranslatableText: false, restore: () => text };
  }
  let nonce: string;
  do { nonce = randomBytes(12).toString('hex'); } while (text.includes(nonce));
  const originals = new Map<string, string>();
  const createToken = (value: string): string => {
    const token = `⟦AT_${nonce}_${originals.size}⟧`;
    originals.set(token, value);
    return token;
  };
  const atoms = pieces.flatMap<{ value: string; token: boolean }>((piece) => piece.protected
    ? [{ value: createToken(piece.value), token: true }]
    : Array.from(piece.value, (value) => ({ value, token: false })));
  const chunks: MaskedChunk[] = [];
  let atomIndex = 0;
  while (atomIndex < atoms.length) {
    let end = atomIndex;
    let bytes = 0;
    let preferredEnd = atomIndex;
    while (end < atoms.length) {
      const atom = atoms[end]!;
      const size = Buffer.byteLength(atom.value, 'utf8');
      if (bytes + size > MAX_TRANSLATION_SEGMENT_BYTES) break;
      bytes += size;
      end++;
      if (!atom.token && /[\s.!?。！？；;]/u.test(atom.value)) preferredEnd = end;
    }
    if (end < atoms.length && preferredEnd > atomIndex) end = preferredEnd;
    const selected = atoms.slice(atomIndex, end);
    chunks.push({ value: selected.map((atom) => atom.value).join('') });
    atomIndex = end;
  }
  const segments: string[] = [];
  for (const chunk of chunks) {
    const natural = chunk.value.replace(TOKEN_PATTERN, '');
    if (!HAS_LANGUAGE.test(natural)) continue;
    chunk.segmentIndex = segments.length;
    segments.push(chunk.value);
  }
  if (segments.length > MAX_TRANSLATION_SEGMENTS) throw new TranslationError('PAYLOAD_TOO_LARGE');
  return {
    segments,
    hasTranslatableText: true,
    restore(translatedSegments) {
      const result = chunks.map((chunk) => chunk.segmentIndex === undefined
        ? chunk.value : translatedSegments[chunk.segmentIndex]).join('');
      // Restore recognized placeholders without validating or rewriting the translation.
      return result.replace(TOKEN_PATTERN, (token) => originals.get(token) ?? token);
    },
  };
}
