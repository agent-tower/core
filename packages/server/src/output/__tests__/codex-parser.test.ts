import { describe, expect, it } from 'vitest'
import { CodexParser } from '../codex-parser.js'
import { MsgStore } from '../msg-store.js'

function feedLine(parser: CodexParser, obj: Record<string, unknown>) {
  parser.processData(JSON.stringify(obj) + '\n')
}

function entries(store: MsgStore) {
  return store.getSnapshot().entries
}

describe('CodexParser mcp_tool_call handling', () => {
  it('should create and update a tool entry for mcp_tool_call started/completed events', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)

    feedLine(parser, {
      type: 'item.started',
      item: {
        id: 'item_2',
        type: 'mcp_tool_call',
        server: 'agent-tower',
        tool: 'post_room_message',
        arguments: { content: 'hello', kind: 'chat' },
        result: null,
        error: null,
        status: 'in_progress',
      },
    })

    feedLine(parser, {
      type: 'item.completed',
      item: {
        id: 'item_2',
        type: 'mcp_tool_call',
        server: 'agent-tower',
        tool: 'post_room_message',
        arguments: { content: 'hello', kind: 'chat' },
        result: { content: [{ type: 'text', text: 'ok' }], structured_content: null },
        error: null,
        status: 'completed',
      },
    })

    const toolEntries = entries(store).filter((entry) => entry.entryType === 'tool_use')

    expect(toolEntries).toHaveLength(1)
    expect(toolEntries[0].id).toBe('item_2')
    expect(toolEntries[0].metadata?.toolId).toBe('item_2')
    expect(toolEntries[0].metadata?.toolName).toBe('post_room_message')
    expect(toolEntries[0].metadata?.action).toBe('tool')
    expect(toolEntries[0].metadata?.status).toBe('success')
    expect(toolEntries[0].content).toContain('Server: agent-tower')
    expect(toolEntries[0].content).toContain('Tool: post_room_message')
    expect(toolEntries[0].content).toContain('Status: completed')
    expect(toolEntries[0].content).toContain('"content": "hello"')
    expect(toolEntries[0].content).toContain('"text": "ok"')
  })

  it('should mark mcp_tool_call entries as failed when completed with an error', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)

    feedLine(parser, {
      type: 'item.started',
      item: {
        id: 'item_failed',
        type: 'mcp_tool_call',
        server: 'agent-tower',
        tool: 'approve_work_request',
        arguments: { work_request_id: 'wr_1' },
        status: 'in_progress',
      },
    })

    feedLine(parser, {
      type: 'item.completed',
      item: {
        id: 'item_failed',
        type: 'mcp_tool_call',
        server: 'agent-tower',
        tool: 'approve_work_request',
        arguments: { work_request_id: 'wr_1' },
        result: null,
        error: { message: 'not allowed' },
        status: 'failed',
      },
    })

    const toolEntry = entries(store).find((entry) => entry.entryType === 'tool_use')

    expect(toolEntry?.metadata?.status).toBe('failed')
    expect(toolEntry?.content).toContain('Error:')
    expect(toolEntry?.content).toContain('not allowed')
  })
})

describe('CodexParser JSON object scanning', () => {
  it('should parse multiple JSON objects on one line', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)
    const first = JSON.stringify({
      type: 'item.completed',
      item: { id: 'msg_1', type: 'agent_message', text: 'first' },
    })
    const second = JSON.stringify({
      type: 'item.completed',
      item: { id: 'msg_2', type: 'agent_message', text: 'second' },
    })

    parser.processData(`${first} ${second}\n`)

    expect(entries(store).map((entry) => [entry.entryType, entry.content])).toEqual([
      ['assistant_message', 'first'],
      ['assistant_message', 'second'],
    ])
  })

  it('should not split on brace pairs inside JSON strings', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)
    const first = JSON.stringify({
      type: 'item.completed',
      item: { id: 'msg_1', type: 'agent_message', text: 'first } { inner' },
    })
    const second = JSON.stringify({
      type: 'item.completed',
      item: { id: 'msg_2', type: 'agent_message', text: 'second' },
    })

    parser.processData(`${first} ${second}\n`)

    expect(entries(store).map((entry) => [entry.entryType, entry.content])).toEqual([
      ['assistant_message', 'first } { inner'],
      ['assistant_message', 'second'],
    ])
  })

  it('should parse JSON split across chunks', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'msg_1', type: 'agent_message', text: 'split chunk' },
    }) + '\n'

    parser.processData(line.slice(0, 25))
    parser.processData(line.slice(25))

    expect(entries(store).map((entry) => [entry.entryType, entry.content])).toEqual([
      ['assistant_message', 'split chunk'],
    ])
  })

  it('should parse final buffered JSON without a trailing newline', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'msg_1', type: 'agent_message', text: 'no newline' },
    })

    parser.processData(line)
    parser.finish()

    expect(entries(store).map((entry) => [entry.entryType, entry.content])).toEqual([
      ['assistant_message', 'no newline'],
    ])
  })
})

describe('CodexParser logical turn completion', () => {
  it('emits successful turn.completed once, after usage/state processing', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)
    const signals: string[] = []
    parser.onTurnCompleted(() => signals.push('completed'))

    feedLine(parser, {
      type: 'item.completed',
      item: { id: 'msg_1', type: 'agent_message', text: 'final answer' },
    })
    feedLine(parser, {
      type: 'turn.completed',
      usage: { input_tokens: 3, output_tokens: 2 },
    })
    feedLine(parser, { type: 'turn.completed', usage: { input_tokens: 99, output_tokens: 99 } })

    expect(signals).toEqual(['completed'])
    expect(entries(store).map((entry) => entry.entryType)).toEqual([
      'assistant_message',
      'token_usage_info',
    ])
  })

  it('does not emit success after turn.failed', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)
    const signals: string[] = []
    parser.onTurnCompleted(() => signals.push('completed'))

    feedLine(parser, { type: 'turn.failed', error: { message: 'provider unavailable' } })
    feedLine(parser, { type: 'turn.completed' })

    expect(signals).toEqual([])
    expect(entries(store).some((entry) => entry.entryType === 'error_message')).toBe(true)
  })
})
