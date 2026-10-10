import { describe, expect, it, vi } from 'vitest'
import { ClaudeCodeParser } from '../claude-code-parser.js'
import { MsgStore } from '../msg-store.js'

function feed(parser: ClaudeCodeParser, message: Record<string, unknown>) {
  parser.processData(JSON.stringify(message) + '\n')
}

describe('Claude Code logical turn lifecycle', () => {
  it('publishes final text and usage before notifying completion, exactly once', () => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)
    const snapshots: unknown[] = []
    const failed = vi.fn()
    parser.onTurnCompleted(() => snapshots.push(structuredClone(store.getSnapshot().entries)))
    parser.onTurnFailed(failed)
    const result = {
      type: 'result', subtype: 'success', result: 'Unknown skill: demo', duration_api_ms: 0,
      usage: { input_tokens: 2, cache_creation_input_tokens: 9780, cache_read_input_tokens: 8493 },
    }
    feed(parser, result)
    feed(parser, result)
    feed(parser, { type: 'result', subtype: 'error_during_execution', is_error: true })
    parser.finish(1)

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject([
      { entryType: 'assistant_message', content: 'Unknown skill: demo' },
      { entryType: 'token_usage_info', metadata: { tokenUsage: { totalTokens: 18275 } } },
    ])
    expect(store.getSnapshot().entries).toHaveLength(2)
    expect(failed).not.toHaveBeenCalled()
  })

  it.each([
    { subtype: 'error_during_execution', is_error: true, result: 'Request failed' },
    { subtype: 'error_max_turns', errors: ['Turn limit reached'] },
    { subtype: 'error_max_budget_usd', is_error: true, errors: ['Budget exceeded'] },
    { subtype: 'success', is_error: true, error: 'Provider failed' },
  ])('notifies failure after recording the final $subtype error', (result) => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)
    const completed = vi.fn()
    const failed = vi.fn(() => {
      expect(store.getSnapshot().entries.at(-1)?.entryType).toBe('error_message')
    })
    parser.onTurnCompleted(completed)
    parser.onTurnFailed(failed)
    feed(parser, { type: 'result', ...result })
    feed(parser, { type: 'result', ...result })
    feed(parser, { type: 'result', subtype: 'success' })
    parser.finish(0)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(completed).not.toHaveBeenCalled()
    expect(store.getSnapshot().entries).toHaveLength(1)
    expect(store.getSnapshot().entries[0].content).toBe(result.result || result.errors?.[0] || result.error)
  })

  it('keeps intermediate messages, tool results and subagent results from ending the root turn', () => {
    const parser = new ClaudeCodeParser(new MsgStore())
    const completed = vi.fn()
    const failed = vi.fn()
    parser.onTurnCompleted(completed)
    parser.onTurnFailed(failed)
    feed(parser, { type: 'stream_event', event: { type: 'message_stop' } })
    feed(parser, { type: 'result', subtype: 'tool_result', tool_use_id: 'tool-1', is_error: true })
    feed(parser, { type: 'result', subtype: 'success', parent_tool_use_id: 'subagent-1' })
    feed(parser, { type: 'result', subtype: 'error_during_execution', parent_tool_use_id: 'subagent-2' })
    expect(completed).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
    feed(parser, { type: 'result', subtype: 'success', parent_tool_use_id: null })
    expect(completed).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
  })

  it('waits for a complete final frame and flushes an unterminated result on exit', () => {
    const parser = new ClaudeCodeParser(new MsgStore())
    const completed = vi.fn()
    parser.onTurnCompleted(completed)
    const frame = JSON.stringify({ type: 'result', subtype: 'success' })
    parser.processData(frame.slice(0, 12))
    expect(completed).not.toHaveBeenCalled()
    parser.processData(frame.slice(12))
    expect(completed).not.toHaveBeenCalled()
    parser.finish(0)
    parser.finish(0)
    expect(completed).toHaveBeenCalledTimes(1)
  })
})
