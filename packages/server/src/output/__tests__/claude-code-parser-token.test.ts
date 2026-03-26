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

function getAssistantEntries(store: MsgStore) {
  const snap = store.getSnapshot()
  return snap.entries.filter((e) => e.entryType === 'assistant_message')
}

function getEntries(store: MsgStore) {
  return store.getSnapshot().entries
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

describe('Claude Code Parser - provider compatibility', () => {
  it('should create an assistant entry when provider only returns final assistant message', () => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)

    feedLine(parser, {
      type: 'assistant',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: '你好！有什么我可以帮你的吗？' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })

    const entries = getAssistantEntries(store)
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toBe('你好！有什么我可以帮你的吗？')
  })

  it('should create an assistant entry when provider emits message_start without content_block events', () => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)

    feedLine(parser, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: 'stream-msg', role: 'assistant' },
      },
    })

    feedLine(parser, {
      type: 'assistant',
      message: {
        id: 'final-msg',
        role: 'assistant',
        content: [{ type: 'text', text: '最终回复仍然应该显示' }],
      },
    })

    const entries = getAssistantEntries(store)
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toBe('最终回复仍然应该显示')
  })

  it('should keep thinking visible when partial tool_use arrives after thinking stream', () => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)

    feedLine(parser, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: 'msg-1', role: 'assistant' },
      },
    })

    feedLine(parser, {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '先检查当前文件内容' },
      },
    })

    feedLine(parser, {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '，再决定下一步' },
      },
    })

    feedLine(parser, {
      type: 'assistant',
      message: {
        id: 'msg-1',
        role: 'assistant',
        stop_reason: null,
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Read',
            input: { file_path: '/tmp/demo.ts' },
          },
        ],
      },
    })

    const entries = getEntries(store)
    expect(entries).toHaveLength(2)
    expect(entries[0].entryType).toBe('thinking')
    expect(entries[0].content).toBe('先检查当前文件内容，再决定下一步')
    expect(entries[1].entryType).toBe('tool_use')
    expect(entries[1].metadata?.toolName).toBe('Read')
  })

  it('should reuse tool entry by tool_use id and update its status from tool_result', () => {
    const store = new MsgStore()
    const parser = new ClaudeCodeParser(store)

    feedLine(parser, {
      type: 'assistant',
      message: {
        id: 'msg-1',
        role: 'assistant',
        stop_reason: null,
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Read',
            input: { file_path: '/tmp/demo.ts' },
          },
        ],
      },
    })

    feedLine(parser, {
      type: 'assistant',
      message: {
        id: 'msg-1',
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Read',
            input: { file_path: '/tmp/demo.ts' },
          },
        ],
      },
    })

    feedLine(parser, {
      type: 'result',
      subtype: 'tool_result',
      tool_use_id: 'toolu_1',
      tool_result: { content: 'ok', is_error: false },
    })

    const entries = getEntries(store)
    expect(entries).toHaveLength(1)
    expect(entries[0].entryType).toBe('tool_use')
    expect(entries[0].metadata?.status).toBe('success')
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
