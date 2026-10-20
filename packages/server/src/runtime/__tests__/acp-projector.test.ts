import type { SessionNotification } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { MsgStore } from '../../output/msg-store.js';
import type { RuntimeDriverEventSink } from '../contracts.js';
import { AcpProjector } from '../acp/projector.js';

function notification(update: Record<string, unknown>): SessionNotification {
  return { sessionId: 'acp-session-1', update } as SessionNotification;
}

function setup() {
  const msgStore = new MsgStore();
  const sink: RuntimeDriverEventSink = {
    stream: vi.fn(),
    process: vi.fn(async () => undefined),
  };
  return { msgStore, sink, projector: new AcpProjector(msgStore, sink) };
}

describe('AcpProjector', () => {
  it('uses main user chunks to separate every stream without adding user log entries', () => {
    const { msgStore, projector } = setup();
    msgStore.textBlocks.begin('turn');
    const send = (sessionUpdate: string, text: string, child = false) => projector.project(notification({
      sessionUpdate, messageId: 'reused', content: { type: 'text', text },
      ...(child ? { _meta: { claudeCode: { parentToolUseId: 'child' } } } : {}),
    }));
    send('user_message_chunk', 'User 1');
    send('agent_message_chunk', 'Main 1'); send('agent_message_chunk', ' tail');
    send('agent_message_chunk', 'Child 1', true);
    send('user_message_chunk', 'User 2'); send('user_message_chunk', ' continued');
    send('agent_message_chunk', 'Main 2'); send('agent_message_chunk', ' tail');
    send('agent_message_chunk', 'Child 2', true);
    const entries = msgStore.getSnapshot().entries;
    expect(entries.map(e => e.content)).toEqual(['Main 1 tail', 'Child 1', 'Main 2 tail', 'Child 2']);
    expect(entries.slice(0, 2).every(e => e.metadata!.textBlock!.state === 'SEALED')).toBe(true);
    expect(entries.slice(2).every(e => e.metadata!.textBlock!.state === 'OPEN')).toBe(true);
    expect(new Set(entries.map(e => e.metadata!.textBlock!.blockId)).size).toBe(4);
    msgStore.textBlocks.end();
  });

  it('keeps child user boundaries local to the child stream', () => {
    const { msgStore, projector } = setup();
    const send = (sessionUpdate: string, text: string, child = false) => projector.project(notification({
      sessionUpdate, messageId: 'reused', content: { type: 'text', text },
      ...(child ? { _meta: { claudeCode: { parentToolUseId: 'child' } } } : {}),
    }));
    send('agent_message_chunk', 'Main'); send('agent_message_chunk', 'Child 1', true);
    send('user_message_chunk', 'Child user', true);
    send('agent_message_chunk', ' tail'); send('agent_message_chunk', 'Child 2', true);
    expect(msgStore.getSnapshot().entries.map(e => e.content)).toEqual(['Main tail', 'Child 1', 'Child 2']);
  });

  it('projects streaming messages without duplicating entries', () => {
    const { msgStore, projector } = setup();

    projector.project(notification({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'message-1',
      content: { type: 'text', text: 'hello ' },
    }));
    projector.project(notification({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'message-1',
      content: { type: 'text', text: 'world' },
    }));

    const entries = msgStore.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entryType: 'assistant_message', content: 'hello world' });
  });

  it('keeps Qwen discrete messages separate when messageId is missing', () => {
    const { msgStore, projector } = setup();

    for (const text of ['first', 'second']) {
      projector.project(notification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        _meta: { qwenDiscreteMessage: true },
      }));
    }

    expect(msgStore.getSnapshot().entries).toMatchObject([
      { entryType: 'assistant_message', content: 'first' },
      { entryType: 'assistant_message', content: 'second' },
    ]);
  });

  it('closes a synthetic message stream at tool boundaries', () => {
    const { msgStore, projector } = setup();

    projector.project(notification({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'before' },
    }));
    projector.project(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-boundary',
      title: 'Run',
      kind: 'execute',
      status: 'completed',
    }));
    projector.project(notification({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'after' },
    }));

    expect(msgStore.getSnapshot().entries).toMatchObject([
      { entryType: 'assistant_message', content: 'before' },
      { entryType: 'tool_use' },
      { entryType: 'assistant_message', content: 'after' },
    ]);
  });

  it('updates tool calls, plans and usage in place', () => {
    const { msgStore, projector } = setup();

    projector.project(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Read file',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: '/tmp/example.ts' },
      content: [{
        type: 'content',
        content: { type: 'text', text: 'reading example.ts' },
      }],
      locations: [{ path: '/tmp/example.ts', line: 12 }],
    }));
    expect(msgStore.getSnapshot().entries[0]).toMatchObject({
      content: expect.stringContaining('reading example.ts'),
      metadata: {
        toolName: 'Read file',
        toolKind: 'read',
        action: 'file_read',
        status: 'in_progress',
        toolInputSummary: '{"path":"/tmp/example.ts"}',
        toolContent: [{ type: 'text', text: 'reading example.ts' }],
        toolLocations: [{ path: '/tmp/example.ts', line: 12 }],
      },
    });
    projector.project(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
      rawOutput: 'done',
    }));
    projector.project(notification({
      sessionUpdate: 'plan',
      entries: [{ content: 'Inspect runtime', status: 'in_progress' }],
    }));
    projector.project(notification({ sessionUpdate: 'usage_update', used: 12, size: 100 }));

    const entries = msgStore.getSnapshot().entries;
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      entryType: 'tool_use',
      content: expect.stringContaining('done'),
      metadata: {
        toolName: 'Read file',
        toolKind: 'read',
        action: 'file_read',
        status: 'success',
        toolInputSummary: '{"path":"/tmp/example.ts"}',
        toolOutputSummary: 'done',
        toolContent: [{ type: 'text', text: 'reading example.ts' }],
        toolLocations: [{ path: '/tmp/example.ts', line: 12 }],
      },
    });
    expect(entries[1].metadata?.todos).toEqual([
      expect.objectContaining({ content: 'Inspect runtime', status: 'in_progress' }),
    ]);
    expect(entries[2].entryType).toBe('token_usage_info');
  });

  it('honors explicit null fields without clearing omitted tool fields', () => {
    const { msgStore, projector } = setup();

    projector.project(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-null',
      title: 'Search workspace',
      kind: 'search',
      status: 'pending',
      rawInput: { query: 'runtime' },
      rawOutput: 'one match',
    }));
    projector.project(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-null',
      title: null,
      status: 'in_progress',
      rawInput: null,
      rawOutput: null,
    }));

    const entry = msgStore.getSnapshot().entries[0];
    expect(entry).toMatchObject({
      metadata: {
        toolName: 'search',
        toolKind: 'search',
        action: 'search',
        status: 'in_progress',
      },
    });
    expect(entry.metadata).not.toHaveProperty('toolInputSummary');
    expect(entry.metadata).not.toHaveProperty('toolOutputSummary');
  });

  it('keeps a bounded preview while accumulating terminal output deltas', () => {
    const { msgStore, projector } = setup();
    projector.project(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-stream',
      title: 'Run command',
      kind: 'execute',
      status: 'in_progress',
    }));
    for (const data of ['a'.repeat(20_000), 'b'.repeat(20_000), 'z'.repeat(20_000)]) {
      projector.project(notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-stream',
        _meta: { terminal_output_delta: { data, terminal_id: 'tool-stream' } },
      }));
    }
    projector.project(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-stream',
      status: 'completed',
    }));

    const [entry] = msgStore.getSnapshot().entries;
    const preview = entry.metadata?.toolOutputSummary as string;
    expect(entry.metadata?.status).toBe('success');
    expect(preview.length).toBeLessThanOrEqual(32 * 1024);
    expect(preview).toContain('[TRUNCATED]');
    expect(preview.startsWith('a')).toBe(true);
    expect(preview.endsWith('z')).toBe(true);
  });

  it('does not duplicate terminal output repeated in the same aggregate update', () => {
    const { msgStore, projector } = setup();
    projector.project(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-aggregate',
      status: 'completed',
      rawOutput: { formatted_output: 'command output', exit_code: 0 },
      _meta: { terminal_output_delta: { data: 'command output', terminal_id: 'tool-aggregate' } },
    }));

    expect(msgStore.getSnapshot().entries[0].metadata?.toolOutputSummary).toBe('command output');
  });

  it('replaces an earlier terminal preview with a newer structured raw output', () => {
    const { msgStore, projector } = setup();
    projector.project(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-replaced-output',
      _meta: { terminal_output_delta: { data: 'old output', terminal_id: 'tool-replaced-output' } },
    }));
    projector.project(notification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-replaced-output',
      status: 'completed',
      rawOutput: { result: 'new output' },
    }));

    expect(msgStore.getSnapshot().entries[0].metadata?.toolOutputSummary).toBe('{"result":"new output"}');
  });

  it('projects MCP startup pseudo-tools as non-blocking warnings instead of user tools', () => {
    const { msgStore, projector } = setup();

    projector.project(notification({
      sessionUpdate: 'tool_call',
      toolCallId: 'mcp_startup.agent-tower',
      title: 'mcp__agent-tower__startup',
      kind: 'other',
      status: 'failed',
      content: [{
        type: 'content',
        content: {
          type: 'text',
          text: '[codex-acp forwarded startup error] MCP server `agent-tower` failed to start: connection closed',
        },
      }],
    }));

    expect(msgStore.getSnapshot().entries).toEqual([
      expect.objectContaining({
        entryType: 'warning_message',
        content: 'MCP server `agent-tower` failed to start: connection closed',
      }),
    ]);
    expect(msgStore.getSnapshot().entries[0].metadata).not.toHaveProperty('toolName');
    expect(msgStore.getSnapshot().entries[0].metadata).toEqual({
      warning: 'MCP server `agent-tower` failed to start: connection closed',
    });
  });

  it('adds a visible, redacted error entry when an ACP prompt fails', () => {
    const { msgStore, projector } = setup();

    projector.projectError(new Error('request failed with token-secretvalue123'));

    const [entry] = msgStore.getSnapshot().entries;
    expect(entry).toMatchObject({ entryType: 'error_message' });
    expect(entry.content).toContain('[REDACTED]');
    expect(entry.content).not.toContain('secretvalue123');
  });
});
