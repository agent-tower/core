import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationQueue } from '../translation-queue.js';
import {
  MAX_TRANSLATION_RESPONSE_BYTES,
  TRANSLATION_FORMAT_PROTOCOL,
  TranslationClient,
  normalizeTranslationApiBaseUrl,
  type TranslationClientRequest,
} from '../translation-client.js';
import { prepareTranslation } from '../translation-protection.js';

const request: TranslationClientRequest = {
  apiBaseUrl: 'https://compatible.example/custom/v2/', model: 'translate-model', apiKey: 'private-key',
  promptTemplate: 'Translate to {{ target_language }}: {{ text }}', targetLanguage: '简体中文', text: 'Hello',
};

function completion(content: unknown, finishReason = 'stop'): Response {
  return Response.json({ choices: [{ finish_reason: finishReason, message: { content, reasoning_content: 'PRIVATE REASONING', tool_calls: [{ private: true }] } }] });
}

describe('OpenAI compatible translation client', () => {
  afterEach(() => vi.useRealTimers());

  it('sends exactly one protected user message with stream false to the configured API base URL', async () => {
    const original = 'Hello [the guide](https://private.example/path) and `secret code`';
    const prepared = prepareTranslation(original);
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      return completion(body.messages.at(-1).content.replace(/^Translate to 简体中文: /, '').replace('Hello', '你好'));
    });
    const client = new TranslationClient({ fetchImpl });
    const translated = await client.translate({ ...request, text: prepared.segments[0]! });
    expect(prepared.restore([translated])).toBe(original.replace('Hello', '你好'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://compatible.example/custom/v2/chat/completions');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer private-key', 'content-type': 'application/json' } });
    expect(JSON.parse(String(init!.body))).toEqual({ model: 'translate-model', messages: [{ role: 'system', content: TRANSLATION_FORMAT_PROTOCOL }, { role: 'user', content: `Translate to 简体中文: ${prepared.segments[0]}` }], stream: false });
    expect(String(init!.body)).not.toContain('private.example');
    expect(String(init!.body)).not.toContain('secret code');
  });

  it('permits an explicitly empty key for a local compatible service and never invents /v1', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => completion('你好'));
    await new TranslationClient({ fetchImpl }).translate({ ...request, apiBaseUrl: 'http://127.0.0.1:9999', apiKey: null });
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:9999/chat/completions');
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).has('authorization')).toBe(false);
    expect(normalizeTranslationApiBaseUrl('https://example.com/v1/chat/completions'))
      .toBe('https://example.com/v1/chat/completions');
  });

  it.each(['ftp://example.com', 'https://user:secret@example.com', 'http://@example.com', 'https://example.com?x=1', 'https://example.com#frag', 'https://example.com?', '/v1'])('rejects invalid base URL without fetching: %s', async (apiBaseUrl) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(new TranslationClient({ fetchImpl }).translate({ ...request, apiBaseUrl })).rejects.toMatchObject({ errorCode: 'INVALID_CONFIG' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses only choices[0].message.content and refuses reasoning/tool-only or truncated results', async () => {
    for (const response of [completion(null), completion(''), completion(['not a string']), completion('partial', 'length'), Response.json({ choices: [] })]) {
      await expect(new TranslationClient({ fetchImpl: async () => response }).translate(request)).rejects.toBeInstanceOf(Error);
    }
    await expect(new TranslationClient({ fetchImpl: async () => completion('正文') }).translate(request)).resolves.toBe('正文');
  });

  it('rejects invalid JSON, malformed UTF-8 and responses over the streaming byte limit', async () => {
    const responses = [
      new Response('provider secret: invalid JSON'),
      new Response(new Uint8Array([0xff, 0xfe])),
      new Response('x'.repeat(MAX_TRANSLATION_RESPONSE_BYTES + 1)),
    ];
    const codes = ['INVALID_RESPONSE', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'];
    for (let index = 0; index < responses.length; index++) {
      const error = await new TranslationClient({ fetchImpl: async () => responses[index]! }).translate(request).catch((value: unknown) => value);
      expect(error).toMatchObject({ errorCode: codes[index] });
      expect(String(error)).not.toContain('provider secret');
    }
  });

  it('sanitizes provider errors, reports only safe status, and bounds Retry-After', async () => {
    for (const [status, errorCode, retryable] of [[401, 'AUTH_FAILED', false], [403, 'AUTH_FAILED', false], [404, 'MODEL_CONFIG_ERROR', false], [429, 'RATE_LIMITED', true], [503, 'UPSTREAM_ERROR', true]] as const) {
      const error = await new TranslationClient({ fetchImpl: async () => new Response('private-key request private text', { status, headers: { 'retry-after': '1000' } }) })
        .translate(request).catch((value: unknown) => value);
      expect(error).toMatchObject({ errorCode, status, retryable });
      expect(JSON.stringify(error)).not.toMatch(/private-key|private text/);
      expect(String(error)).toBe(`TranslationError: ${errorCode}`);
      if (status === 429) expect(error).toMatchObject({ retryAfterMs: 30_000 });
    }
    const networkError = await new TranslationClient({ fetchImpl: async () => { throw new Error('url/private-key/private text'); } })
      .translate(request).catch((value: unknown) => value);
    expect(networkError).toMatchObject({ errorCode: 'NETWORK_ERROR', retryable: true });
    expect(String(networkError)).not.toContain('private');
  });

  it('honors pre-cancellation without issuing a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(new TranslationClient({ fetchImpl }).translate({ ...request, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ errorCode: 'CANCELLED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts an active request but retains ownership until the transport settles', async () => {
    let finish!: (response: Response) => void;
    let transportSignal!: AbortSignal;
    const fetchImpl: typeof fetch = async (_url, init) => {
      transportSignal = init!.signal!;
      return await new Promise<Response>((resolve) => { finish = resolve; });
    };
    const controller = new AbortController();
    const promise = new TranslationClient({ fetchImpl }).translate({ ...request, signal: controller.signal });
    let settled = false;
    void promise.then(() => { settled = true; }, () => { settled = true; });
    controller.abort();
    await Promise.resolve();
    expect(transportSignal.aborted).toBe(true);
    expect(settled).toBe(false);
    finish(completion('late result'));
    await expect(promise).rejects.toMatchObject({ errorCode: 'CANCELLED' });
  });

  it('enforces the HTTP deadline across connection and body reading', async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = async (_url, init) => await new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('private request')), { once: true });
    });
    const connection = new TranslationClient({ fetchImpl, timeoutMs: 50 }).translate(request);
    const connectionCheck = expect(connection).rejects.toMatchObject({ errorCode: 'TIMEOUT', retryable: true });
    await vi.advanceTimersByTimeAsync(50);
    await connectionCheck;

    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":')); },
      cancel() { cancelled = true; },
    });
    const streaming = new TranslationClient({ fetchImpl: async () => new Response(body), timeoutMs: 50 }).translate(request);
    const streamingCheck = expect(streaming).rejects.toMatchObject({ errorCode: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(50);
    await streamingCheck;
    expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains body ownership until asynchronous stream cancellation has settled', async () => {
    let finishCancel!: () => void;
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    const body = new ReadableStream<Uint8Array>({
      pull() { bodyStarted(); },
      cancel: async () => await new Promise<void>((resolve) => { finishCancel = resolve; }),
    });
    const controller = new AbortController();
    const promise = new TranslationClient({ fetchImpl: async () => new Response(body) })
      .translate({ ...request, signal: controller.signal });
    let settled = false;
    void promise.then(() => { settled = true; }, () => { settled = true; });
    await started;
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishCancel();
    await expect(promise).rejects.toMatchObject({ errorCode: 'CANCELLED' });
  });
  it.each([
    'Hello <br><div>\nprivateHtmlSentinel\n</div>',
    'Hello <img src="local"><script>\nprivateScriptSentinel\n</script>',
    'Hello <span>local</span><br><div>\nprivateHtmlSentinel\n</div>',
    'Hello <br><!--\nprivateCommentSentinel\n-->',
    'Hello <br><div>\nprivateUnclosedSentinel',
  ])('keeps every cross-line HTML element out of the actual HTTP payload: %s', async original => {
    const prepared = prepareTranslation(original);
    const outbound: string[] = [];
    const client = new TranslationClient({ fetchImpl: async (_url, init) => {
      outbound.push(String(init?.body));
      return completion(JSON.parse(String(init?.body)).messages.at(-1).content.replace(/^Translate to 简体中文: /, ''));
    } });
    const results = [];
    for (const text of prepared.segments) results.push(await client.translate({ ...request, text }));
    expect(outbound.length).toBeGreaterThan(0);
    expect(outbound.join('')).not.toMatch(/private(?:Html|Script|Comment|Unclosed)Sentinel/);
    expect(prepared.restore(results)).toBe(original);
  });

  it('closes malformed UTF-8 response bodies which stay open on a real loopback connection', async () => {
    let opened = 0; let closed = 0;
    const sockets = new Set<Socket>();
    const server = createServer((req, res) => {
      req.resume(); opened++; res.on('close', () => closed++);
      res.writeHead(200, { 'content-type': 'application/json' }); res.write(Buffer.from([255]));
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
    const queue = new TranslationQueue({ maxConcurrency: 1 });
    const client = new TranslationClient({ timeoutMs: 1000 });
    try {
      for (let index = 0; index < 2; index++) {
        await expect(queue.run({ id: String(index), laneKey: 'loopback', direction: 'DISPLAY' }, () => client.translate({ ...request, apiBaseUrl: `http://127.0.0.1:${address.port}` }))).rejects.toMatchObject({ errorCode: 'INVALID_RESPONSE' });
      }
      await vi.waitFor(() => expect(closed).toBe(2), { timeout: 2000 });
      expect(queue.stats.inflight).toBe(0); expect(opened).toBe(2); expect(closed).toBe(2);
    } finally {
      await queue.shutdown(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(['malformed', 'timeout', 'shutdown'] as const)('holds the global request slot until asynchronous body cancellation settles (%s)', async mode => {
    let finishCancel!: () => void;
    const cancelled = vi.fn(async () => await new Promise<void>(resolve => { finishCancel = resolve; }));
    const body = new ReadableStream<Uint8Array>({ start(controller) { if (mode === 'malformed') controller.enqueue(new Uint8Array([255])); }, cancel: cancelled });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body)).mockResolvedValue(completion('Next result'));
    const queue = new TranslationQueue({ maxConcurrency: 1 });
    const client = new TranslationClient({ fetchImpl, timeoutMs: mode === 'timeout' ? 20 : 1000 });
    const first = queue.run({ id: 'first', laneKey: 'a', direction: 'DISPLAY' }, signal => client.translate({ ...request, signal })).catch(error => error);
    const second = queue.run({ id: 'second', laneKey: 'b', direction: 'DISPLAY' }, signal => client.translate({ ...request, signal })).catch(error => error);
    let shutdown: Promise<void> | undefined;
    let shutdownDone = false;
    try {
      if (mode === 'shutdown') {
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
        shutdown = queue.shutdown().then(() => { shutdownDone = true; });
      }
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1), { timeout: 200 });
      expect(fetchImpl).toHaveBeenCalledTimes(1); expect(queue.stats.inflight).toBe(1);
      expect(shutdownDone).toBe(false);
      finishCancel();
      expect(await first).toMatchObject(mode === 'shutdown' ? { code: 'CANCELLED' } : { errorCode: mode === 'timeout' ? 'TIMEOUT' : 'INVALID_RESPONSE' });
      if (mode === 'shutdown') { await shutdown; expect(fetchImpl).toHaveBeenCalledTimes(1); }
      else { expect(await second).toBe('Next result'); expect(fetchImpl).toHaveBeenCalledTimes(2); }
    } finally { finishCancel?.(); await Promise.all([first, second, queue.shutdown()]); }
    expect(queue.stats).toEqual({ inflight: 0, pending: 0 });
    expect(body.locked).toBe(false);
  });

});
