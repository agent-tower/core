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
