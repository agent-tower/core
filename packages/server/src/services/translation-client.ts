import { TranslationError } from './translation-errors.js';
import { MAX_TRANSLATION_SEGMENT_BYTES, renderTranslationTemplate } from './translation-protection.js';

export { TranslationError } from './translation-errors.js';
export type { TranslationErrorCode } from './translation-errors.js';

export const TRANSLATION_HTTP_TIMEOUT_MS = 45_000;
export const MAX_TRANSLATION_RESPONSE_BYTES = 128 * 1024;

/** Transport rules complement the one user-configurable translation template. */
export const TRANSLATION_FORMAT_PROTOCOL = 'Translate only the natural-language spans in the user message into its requested target language. Tokens of the form ⟦AT_<hex>_<number>⟧ are opaque format placeholders: preserve every token byte-for-byte, exactly once and in the original order. Do not interpret or restore tokens. If the input begins or ends with a token, the output must begin or end with that exact token, with no surrounding whitespace. Do not add explanations, quotation marks, code fences, line breaks, Markdown, links, paths or other resource syntax. Return only the translated text with its unchanged tokens.';

export interface TranslationClientRequest {
  apiBaseUrl: string;
  model: string;
  /** Server-only. Do not serialize this request into storage, events or logs. */
  apiKey: string | null;
  promptTemplate: string;
  targetLanguage: string;
  /** One already-protected segment, never an assembled Agent prompt. */
  text: string;
  signal?: AbortSignal;
}

export interface TranslationClientOptions {
  fetchImpl?: typeof fetch;
  /** Shorter deadlines are useful for deterministic tests; production defaults to 45s. */
  timeoutMs?: number;
}

export function normalizeTranslationApiBaseUrl(value: string): string {
  try {
    const input = value.trim();
    const url = new URL(input);
    if (!/^https?:\/\//i.test(input) || (url.protocol !== 'http:' && url.protocol !== 'https:')
      || !url.host || url.username || url.password || input.includes('?') || input.includes('#')
      || /[\r\n\0]/.test(input) || /^https?:\/\/[^/]*@/i.test(input)) throw new Error();
    return url.href.replace(/\/+$/, '');
  } catch {
    throw new TranslationError('INVALID_CONFIG');
  }
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(30_000, Math.round(delay)) : undefined;
}

function httpError(response: Response): TranslationError {
  const status = response.status;
  if (status === 401 || status === 403) return new TranslationError('AUTH_FAILED', { status });
  if (status === 400 || status === 404 || status === 422) return new TranslationError('MODEL_CONFIG_ERROR', { status });
  if (status === 429) return new TranslationError('RATE_LIMITED', { status, retryable: true, retryAfterMs: retryAfterMs(response) });
  return new TranslationError('UPSTREAM_ERROR', { status, retryable: status === 408 || status === 425 || status >= 500, retryAfterMs: retryAfterMs(response) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(response: Response, controller: AbortController): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new TranslationError('EMPTY_RESPONSE');
  let cancellation: Promise<void> | undefined;
  let reachedEof = false;
  const cancel = () => { cancellation ??= reader.cancel().catch(() => {}); };
  controller.signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { reachedEof = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_TRANSLATION_RESPONSE_BYTES) {
        cancel();
        throw new TranslationError('RESPONSE_TOO_LARGE');
      }
      try { body += decoder.decode(chunk.value, { stream: true }); }
      catch { throw new TranslationError('INVALID_RESPONSE'); }
    }
    try {
      body += decoder.decode();
      return JSON.parse(body) as unknown;
    } catch {
      throw new TranslationError('INVALID_RESPONSE');
    }
  } finally {
    // Decoding/read failures can leave the upstream body open. Keep ownership
    // (and the request deadline) until every unfinished body has been cancelled.
    if (!reachedEof) cancel();
    controller.signal.removeEventListener('abort', cancel);
    await cancellation;
    reader.releaseLock();
  }
}

/** One HTTP request per call. All admission, fairness and retry ownership stays in the scheduler. */
export class TranslationClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: TranslationClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? TRANSLATION_HTTP_TIMEOUT_MS;
  }

  async translate(request: TranslationClientRequest): Promise<string> {
    const baseUrl = normalizeTranslationApiBaseUrl(request.apiBaseUrl);
    if (!request.model.trim() || /[\r\n\0]/.test(request.model) || /[\r\n\0]/.test(request.apiKey ?? '')
      || !request.targetLanguage.trim() || Array.from(request.targetLanguage).length > 64
      || /[\r\n\0]/.test(request.targetLanguage)) throw new TranslationError('INVALID_CONFIG');
    if (Buffer.byteLength(request.text, 'utf8') > MAX_TRANSLATION_SEGMENT_BYTES) throw new TranslationError('PAYLOAD_TOO_LARGE');
    const content = renderTranslationTemplate(request.promptTemplate, request.targetLanguage, request.text);
    if (request.signal?.aborted) throw new TranslationError('CANCELLED');
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) { timedOut = true; controller.abort(); }
    }, this.timeoutMs);
    try {
      const execute = async (): Promise<string> => {
        const response = await this.fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json', ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}) },
          body: JSON.stringify({ model: request.model, messages: [{ role: 'system', content: TRANSLATION_FORMAT_PROTOCOL }, { role: 'user', content }], stream: false }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          await response.body?.cancel().catch(() => {});
          throw new TranslationError(timedOut ? 'TIMEOUT' : 'CANCELLED', { retryable: timedOut });
        }
        if (!response.ok) {
          // Never parse or retain third-party error text: providers may echo secrets/prompts.
          await response.body?.cancel().catch(() => {});
          throw httpError(response);
        }
        const payload = await readJson(response, controller);
        if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
          throw new TranslationError('INVALID_RESPONSE');
        }
        const choice = payload.choices[0];
        if (choice.finish_reason === 'length') throw new TranslationError('TRUNCATED_RESPONSE');
        if (!isRecord(choice.message) || typeof choice.message.content !== 'string' || !choice.message.content.trim()) {
          throw new TranslationError('EMPTY_RESPONSE');
        }
        return choice.message.content;
      };
      // Keep request ownership until the transport has actually settled. Racing
      // abort against fetch would let the scheduler lend out a still-used slot.
      return await execute();
    } catch (error) {
      if (timedOut) throw new TranslationError('TIMEOUT', { retryable: true });
      if (request.signal?.aborted) throw new TranslationError('CANCELLED');
      if (error instanceof TranslationError) throw error;
      throw new TranslationError('NETWORK_ERROR', { retryable: true });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
