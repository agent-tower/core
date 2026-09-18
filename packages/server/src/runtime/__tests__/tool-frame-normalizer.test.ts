import { describe, expect, it } from 'vitest';
import { normalizeAcpToolFrame } from '../acp/agents/tool-frame-normalizer.js';

function imageFrame(method: 'session/update' | 'session/request_permission', imageSize: number) {
  const content = [{
    type: 'content',
    content: { type: 'image', data: 'x'.repeat(imageSize), mimeType: 'image/png' },
  }];
  if (method === 'session/request_permission') {
    return {
      jsonrpc: '2.0',
      id: 7,
      method,
      params: {
        sessionId: 'session-1',
        toolCall: { toolCallId: 'call_1', title: 'read_image', content },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    } as Record<string, unknown>;
  }
  return {
    jsonrpc: '2.0',
    method,
    params: {
      sessionId: 'session-1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'read_image', content },
    },
  } as Record<string, unknown>;
}

describe('normalizeAcpToolFrame', () => {
  it('replaces an inline base64 image with a placeholder that keeps its size', () => {
    const frame = imageFrame('session/update', 2 * 1024 * 1024);
    const update = (frame.params as Record<string, unknown>).update as Record<string, unknown>;

    expect(normalizeAcpToolFrame(frame)).toBe(frame);
    expect(update.title).toBe('read_image');
    expect(update.content).toEqual([
      { type: 'content', content: { type: 'text', text: '[image omitted: image/png, 1.5 MiB]' } },
    ]);
  });

  it('bounds the tool call repeated by a permission request', () => {
    const frame = imageFrame('session/request_permission', 2 * 1024 * 1024);
    const params = frame.params as Record<string, unknown>;

    normalizeAcpToolFrame(frame);

    expect((params.toolCall as Record<string, unknown>).content).toEqual([
      { type: 'content', content: { type: 'text', text: '[image omitted: image/png, 1.5 MiB]' } },
    ]);
    // Permission options are the client's only way to answer; they must survive.
    expect(params.options).toEqual([{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]);
  });

  it('leaves frames and tool payloads it has nothing to bound alone', () => {
    const message = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk' } },
    } as Record<string, unknown>;
    expect(normalizeAcpToolFrame(message)).toBe(message);
    expect(message.params).toEqual({
      sessionId: 'session-1',
      update: { sessionUpdate: 'agent_message_chunk' },
    });

    // A small image block is not worth rewriting: the projector renders it as
    // `unsupported` either way.
    const small = imageFrame('session/update', 8);
    const update = (small.params as Record<string, unknown>).update as Record<string, unknown>;
    const content = update.content as unknown[];
    normalizeAcpToolFrame(small);
    expect(update.content).toStrictEqual(content);
    expect((update.content as unknown[])[0]).toBe(content[0]);
  });

  it('bounds a non-binary tool content entry instead of dropping it', () => {
    const frame = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          content: [{ type: 'content', content: { type: 'text', text: 'y'.repeat(64 * 1024) } }],
        },
      },
    } as Record<string, unknown>;
    const update = (frame.params as Record<string, unknown>).update as Record<string, unknown>;

    normalizeAcpToolFrame(frame);

    const bounded = (update.content as Array<Record<string, unknown>>)[0];
    // The replacement must stay a valid `ToolCallContent`, otherwise the SDK
    // schema would silently skip the entry.
    expect(bounded).toMatchObject({ type: 'content', content: { type: 'text' } });
    expect(bounded.content).toMatchObject({ text: expect.stringContaining('[TRUNCATED]') });
    const text = (bounded.content as Record<string, unknown>).text as string;
    expect(text.length).toBeGreaterThan(32 * 1024);
    expect(text.length).toBeLessThanOrEqual(33 * 1024);
  });

  it('drops every inline image once the content array has to be truncated', () => {
    const frame = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_1',
          content: [0, 1, 2].map(index => ({
            type: 'content',
            content: { type: 'image', data: `${index}${'x'.repeat(16 * 1024)}`, mimeType: 'image/png' },
          })),
        },
      },
    } as Record<string, unknown>;
    const update = (frame.params as Record<string, unknown>).update as Record<string, unknown>;

    normalizeAcpToolFrame(frame);

    const content = update.content as Array<Record<string, unknown>>;
    expect(content.map(entry => (entry.content as Record<string, unknown>).text))
      .toEqual([
        '[image omitted: image/png, 12.0 KiB]',
        '[image omitted: image/png, 12.0 KiB]',
        '[image omitted: image/png, 12.0 KiB]',
      ]);
  });
});
