/**
 * ClaudeCodeParser Token 提取测试
 */
import { describe, it, expect } from 'vitest'
import { MsgStore } from '../msg-store.js'
import { ClaudeCodeParser } from '../claude-code-parser.js'

function feedLine(parser: ClaudeCodeParser, obj: Record<string, unknown>) {
  parser.processData(JSON.stringify(obj) + '\n')
}

function getTokenEntries(store: MsgStore) {
  const snap = store.getSnapshot()
  return snap.entries.filter((e) => e.entryType === 'token_usage_info')
}

describe('Claude Code Token - 使用 assistant 消息的 per-turn usage', () => {
  it('should use last assistant message usage (not cumulative result usage)', () => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)

    // 模拟多轮对话：assistant 消息携带 per-turn usage
    feedLine(parser, {
      type: 'assistant',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        usage: {
          input_tokens: 35000,
          output_tokens: 500,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })

    // 第二轮 assistant（上下文增长）
    feedLine(parser, {
      type: 'assistant',
      message: {
        id: 'msg-2',
        role: 'assistant',
        content: [{ type: 'text', text: 'world' }],
        usage: {
          input_tokens: 2000,
          output_tokens: 300,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 40000,
        },
      },
    })

    // result 消息（usage 是累计值，不应该使用）
    feedLine(parser, {
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 999999,  // 累计值，很大
        output_tokens: 999999,
      },
      modelUsage: {
        'claude-opus-4.6': {
          inputTokens: 999999,
          outputTokens: 999999,
          contextWindow: 200000,
        },
      },
    })

    const entries = getTokenEntries(store)
    expect(entries).toHaveLength(1)

    const tu = entries[0].metadata!.tokenUsage!
    // 应该使用最后一条 assistant 消息的 per-turn usage:
    // input_tokens(2000) + cache_creation(5000) + cache_read(40000) = 47000
    expect(tu.totalTokens).toBe(47000)
    expect(tu.modelContextWindow).toBe(200000)
  })

  it('should compute totalTokens as input + cache_creation + cache_read (matching Claude Code statusline)', () => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)

    feedLine(parser, {
      type: 'assistant',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input_tokens: 5000,
          output_tokens: 200,
          cache_creation_input_tokens: 10000,
          cache_read_input_tokens: 30000,
        },
      },
    })

    feedLine(parser, {
      type: 'result',
      subtype: 'success',
      modelUsage: {
        'claude-opus-4.6': { contextWindow: 200000 },
      },
    })

    const entries = getTokenEntries(store)
    expect(entries).toHaveLength(1)
    const tu = entries[0].metadata!.tokenUsage!
    // 5000 + 10000 + 30000 = 45000 (不含 output_tokens)
    expect(tu.totalTokens).toBe(45000)
  })
})

describe('Claude Code Token - contextWindow 提取', () => {
  it('should extract contextWindow from modelUsage (camelCase)', () => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)

    feedLine(parser, {
      type: 'assistant',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    })

    feedLine(parser, {
      type: 'result',
      subtype: 'success',
      modelUsage: {
        'claude-opus-4.6': { contextWindow: 200000 },
      },
    })

    const entries = getTokenEntries(store)
    expect(entries).toHaveLength(1)
    expect(entries[0].metadata!.tokenUsage!.modelContextWindow).toBe(200000)
  })

  it('should fallback to model_usage (snake_case) for contextWindow', () => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)

    feedLine(parser, {
      type: 'assistant',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    })

    feedLine(parser, {
      type: 'result',
      subtype: 'success',
      model_usage: {
        'claude-sonnet-4-20250514': { context_window: 200000 },
      },
    })

    const entries = getTokenEntries(store)
    expect(entries).toHaveLength(1)
    expect(entries[0].metadata!.tokenUsage!.modelContextWindow).toBe(200000)
  })
})

describe('Claude Code Token - 回退和边界用例', () => {
  it('should fallback to result.usage when no assistant message has usage', () => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)

    feedLine(parser, {
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
      },
    })

    const entries = getTokenEntries(store)
    expect(entries).toHaveLength(1)
    const tu = entries[0].metadata!.tokenUsage!
    expect(tu.totalTokens).toBe(200)
  })

  it('should not generate token_usage_info when result has no data', () => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)

    feedLine(parser, {
      type: 'result',
      subtype: 'success',
    })

    const entries = getTokenEntries(store)
    expect(entries).toHaveLength(0)
  })

  it('should not extract token usage from tool_result subtype', () => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)

    feedLine(parser, {
      type: 'result',
      subtype: 'tool_result',
      tool_use_id: 'tool-1',
      usage: { input_tokens: 100, output_tokens: 50 },
    })

    const entries = getTokenEntries(store)
    expect(entries).toHaveLength(0)
  })

  it('should not throw on malformed usage fields', () => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)

    feedLine(parser, {
      type: 'result',
      subtype: 'success',
      usage: 'not-an-object' as unknown,
    })

    // Parser should still work
    feedLine(parser, {
      type: 'assistant',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      },
    })
  })

  it('should handle assistant message without usage field', () => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)

    feedLine(parser, {
      type: 'assistant',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        // no usage field
      },
    })

    feedLine(parser, {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 100, output_tokens: 50 },
    })

    const entries = getTokenEntries(store)
    expect(entries).toHaveLength(1)
    // Falls back to result.usage
    expect(entries[0].metadata!.tokenUsage!.totalTokens).toBe(150)
  })
})
