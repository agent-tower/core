import { describe, expect, it } from 'vitest'
import { CursorAgentParser } from '../cursor-agent-parser.js'
import { MsgStore } from '../msg-store.js'
import { createUserMessage } from '../types.js'

function feedLine(parser: CursorAgentParser, obj: Record<string, unknown>) {
  parser.processData(JSON.stringify(obj) + '\n')
}

describe('CursorAgentParser user echo handling', () => {
  it('should ignore echoed user messages because SessionManager already persisted them', () => {
    const store = new MsgStore()
    store.restoreFromSnapshot({
      entries: [createUserMessage('你是谁')],
    })

    const parser = new CursorAgentParser(store)

    feedLine(parser, {
      type: 'system',
      model: 'Auto',
      session_id: 'cursor-session-1',
    })

    feedLine(parser, {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '你是谁' }],
      },
      session_id: 'cursor-session-1',
    })

    feedLine(parser, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '我是 Auto' }],
      },
      session_id: 'cursor-session-1',
    })

    const snapshot = store.getSnapshot()
    const userEntries = snapshot.entries.filter((entry) => entry.entryType === 'user_message')

    expect(snapshot.sessionId).toBe('cursor-session-1')
    expect(userEntries).toHaveLength(1)
    expect(snapshot.entries.map((entry) => [entry.entryType, entry.content])).toEqual([
      ['user_message', '你是谁'],
      ['system_message', 'System initialized with model: Auto'],
      ['assistant_message', '我是 Auto'],
    ])
  })
})

describe('CursorAgentParser unknown message type handling', () => {
  it('should not display raw JSON for unknown message types', () => {
    const store = new MsgStore()
    const parser = new CursorAgentParser(store)

    feedLine(parser, {
      type: 'system',
      model: 'Auto',
      session_id: 'cursor-session-unknown',
    })

    feedLine(parser, {
      type: 'unknown_future_event',
      someField: 'someValue',
      session_id: 'cursor-session-unknown',
    })

    feedLine(parser, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      },
      session_id: 'cursor-session-unknown',
    })

    const snapshot = store.getSnapshot()
    const rawJsonEntries = snapshot.entries.filter(
      (entry) => entry.content.includes('"type":"unknown_future_event"') || entry.content.includes('someField')
    )
    expect(rawJsonEntries).toHaveLength(0)
    expect(snapshot.entries.map((e) => [e.entryType, e.content])).toEqual([
      ['system_message', 'System initialized with model: Auto'],
      ['assistant_message', 'hello'],
    ])
  })
})

describe('CursorAgentParser interaction_query (web_search / web_fetch) handling', () => {
  it('should create tool_use entries for web_search and web_fetch, not show raw JSON', () => {
    const store = new MsgStore()
    const parser = new CursorAgentParser(store)

    feedLine(parser, { type: 'system', model: 'Auto', session_id: 'cursor-s1' })

    // web search request
    feedLine(parser, {
      type: 'interaction_query',
      subtype: 'request',
      query_type: 'webSearchRequestQuery',
      query: {
        id: 8,
        webSearchRequestQuery: {
          args: { searchTerm: '今天天气', toolCallId: 'toolu_search_001' },
        },
      },
      session_id: 'cursor-s1',
    })

    // web search approved (response)
    feedLine(parser, {
      type: 'interaction_query',
      subtype: 'response',
      query_type: 'webSearchRequestQuery',
      response: { id: 8, webSearchRequestResponse: { approved: {} } },
      session_id: 'cursor-s1',
    })

    // tool_call completed for web search
    feedLine(parser, {
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'toolu_search_001',
      tool_call: { webSearchToolCall: { result: { content: '晴天 25°C' } } },
      session_id: 'cursor-s1',
    })

    // web fetch request
    feedLine(parser, {
      type: 'interaction_query',
      subtype: 'request',
      query_type: 'webFetchRequestQuery',
      query: {
        id: 9,
        webFetchRequestQuery: {
          args: { url: 'https://example.com', toolCallId: 'toolu_fetch_002' },
          skipApproval: false,
        },
      },
      session_id: 'cursor-s1',
    })

    // web fetch approved
    feedLine(parser, {
      type: 'interaction_query',
      subtype: 'response',
      query_type: 'webFetchRequestQuery',
      response: { id: 9, webFetchRequestResponse: { approved: {} } },
      session_id: 'cursor-s1',
    })

    // tool_call completed for web fetch
    feedLine(parser, {
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'toolu_fetch_002',
      tool_call: { webFetchToolCall: { result: { content: '<html>...</html>' } } },
      session_id: 'cursor-s1',
    })

    const snapshot = store.getSnapshot()

    // 不能有任何原始 JSON 泄漏
    const rawJsonEntries = snapshot.entries.filter(
      (e) =>
        e.content.includes('"type":"interaction_query"') ||
        e.content.includes('webSearchRequestQuery') ||
        e.content.includes('webFetchRequestQuery')
    )
    expect(rawJsonEntries).toHaveLength(0)

    const toolEntries = snapshot.entries.filter((e) => e.entryType === 'tool_use')
    expect(toolEntries).toHaveLength(2)

    const searchEntry = toolEntries[0]
    expect(searchEntry.metadata?.toolName).toBe('web_search')
    expect(searchEntry.content).toBe('今天天气')
    expect(searchEntry.metadata?.status).toBe('success')

    const fetchEntry = toolEntries[1]
    expect(fetchEntry.metadata?.toolName).toBe('web_fetch')
    expect(fetchEntry.content).toBe('https://example.com')
    expect(fetchEntry.metadata?.status).toBe('success')
  })
})

describe('CursorAgentParser retry/connection handling', () => {
  it('should ignore connection JSON and replace replayed assistant output after retry', () => {
    const store = new MsgStore()
    const parser = new CursorAgentParser(store)

    feedLine(parser, {
      type: 'system',
      model: 'Opus 4.6 1M Max Thinking',
      session_id: 'cursor-session-2',
    })

    feedLine(parser, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
      },
      session_id: 'cursor-session-2',
    })

    feedLine(parser, {
      type: 'connection',
      subtype: 'reconnecting',
      session_id: 'cursor-session-2',
    })

    parser.processData(
      `${JSON.stringify({
        type: 'retry',
        subtype: 'starting',
        session_id: 'cursor-session-2',
        attempt: 1,
        is_resume: true,
      })} ${JSON.stringify({
        type: 'retry',
        subtype: 'resuming',
        session_id: 'cursor-session-2',
        attempt: 1,
        checkpoint_turn_count: 2,
      })}\n`
    )

    feedLine(parser, {
      type: 'connection',
      subtype: 'reconnected',
      session_id: 'cursor-session-2',
    })

    feedLine(parser, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
      },
      session_id: 'cursor-session-2',
    })

    const snapshot = store.getSnapshot()
    const assistantEntries = snapshot.entries.filter((entry) => entry.entryType === 'assistant_message')
    const rawJsonEntries = snapshot.entries.filter(
      (entry) =>
        entry.content.includes('"type":"connection"') ||
        entry.content.includes('"type":"retry"')
    )

    expect(assistantEntries).toHaveLength(1)
    expect(assistantEntries[0].content).toBe('hi')
    expect(rawJsonEntries).toHaveLength(0)
    expect(snapshot.entries.map((entry) => [entry.entryType, entry.content])).toEqual([
      ['system_message', 'System initialized with model: Opus 4.6 1M Max Thinking'],
      ['assistant_message', 'hi'],
      ['error_message', 'Resuming request (attempt 1) from checkpoint turn 2...'],
    ])
  })
})
