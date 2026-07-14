import { describe, expect, it } from 'vitest'
import { CodexParser } from '../codex-parser.js'
import { MsgStore } from '../msg-store.js'

function entries(store: MsgStore) {
  return store.getSnapshot().entries
}

/**
 * 覆盖"进程仍在但 UI 长时间无新输出"相关的 parser 行为：
 * 半包缓冲、双 finish 竞态、stderr-only、长静默恢复、CRLF。
 */
describe('CodexParser stall-related resilience', () => {
  it('does not duplicate entries when finish() is called twice (PTY exit → pipeline destroy)', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)
    // 最后一行没有尾随换行（进程被 kill / 输出截断的典型情形）
    parser.processData(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'msg_1', type: 'agent_message', text: 'tail without newline' },
      })
    )

    // AgentPipeline.onExit 先调用 finish(exitCode)，随后 destroy() 再调用 finish()
    parser.finish(0)
    parser.finish()

    const msgs = entries(store).filter((e) => e.entryType === 'assistant_message')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('tail without newline')
  })

  it('recovers cleanly after a long silence between chunks (byte-by-byte tail)', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)
    const line =
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'msg_1', type: 'agent_message', text: 'slow drip' },
      }) + '\n'

    // 前半段到达后长时间无数据（模拟上游断流又恢复），随后逐字节续传
    parser.processData(line.slice(0, 10))
    for (const ch of line.slice(10)) {
      parser.processData(ch)
    }

    expect(entries(store).map((e) => [e.entryType, e.content])).toEqual([
      ['assistant_message', 'slow drip'],
    ])
  })

  it('parses CRLF-terminated JSONL (PTY converts \\n to \\r\\n)', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)
    parser.processData(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'msg_1', type: 'agent_message', text: 'crlf line' },
      }) + '\r\n'
    )

    expect(entries(store).map((e) => e.content)).toEqual(['crlf line'])
  })

  it('surfaces stderr-only output as an error entry when the process exits non-zero', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)
    parser.processData('thread panicked at src/main.rs\n')
    parser.processData('caused by: connection reset by peer\n')

    parser.finish(101)

    const errors = entries(store).filter((e) => e.entryType === 'error_message')
    expect(errors).toHaveLength(1)
    expect(errors[0].content).toContain('exited with code 101')
    expect(errors[0].content).toContain('thread panicked at src/main.rs')
    expect(errors[0].content).toContain('connection reset by peer')
  })

  it('produces no entries for stderr-only output when the process exits 0 (known blind spot)', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)
    parser.processData('WARN transient stream error, retrying\n')

    parser.finish(0)

    // 现状：非 JSON 行 + exit 0 → UI 完全空白。此测试固化现状，
    // 若未来改为展示告警行，应同步更新此断言。
    expect(entries(store)).toHaveLength(0)
  })

  it('keeps the retry error entry updated in place instead of appending', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)
    const retry = (n: number) =>
      JSON.stringify({ type: 'error', message: `Reconnecting... ${n}/5 (stream disconnected)` }) + '\n'

    parser.processData(retry(1))
    parser.processData(retry(2))
    parser.processData(retry(3))

    const errors = entries(store).filter((e) => e.entryType === 'error_message')
    expect(errors).toHaveLength(1)
    expect(errors[0].content).toContain('3/5')
  })
})

describe('CodexParser work-progress items (file_change / todo_list)', () => {
  it('renders file_change items so long edit phases are visible in the UI', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)
    parser.processData(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_5',
          type: 'file_change',
          changes: [
            { path: '/repo/packages/server/src/services/session-manager.ts', kind: 'update' },
            { path: '/repo/packages/server/src/new-file.ts', kind: 'add' },
          ],
          status: 'completed',
        },
      }) + '\n'
    )

    const all = entries(store)
    expect(all).toHaveLength(1)
    expect(all[0].content).toContain('session-manager.ts')
    expect(all[0].content).toContain('new-file.ts')
  })

  it('upserts todo_list items in place across item.started/item.updated/item.completed', () => {
    const store = new MsgStore()
    const parser = new CodexParser(store)
    const todo = (completed: boolean) => ({
      id: 'item_7',
      type: 'todo_list',
      items: [
        { text: 'step one', completed: true },
        { text: 'step two', completed },
      ],
    })

    parser.processData(JSON.stringify({ type: 'item.started', item: todo(false) }) + '\n')
    parser.processData(JSON.stringify({ type: 'item.updated', item: todo(false) }) + '\n')
    parser.processData(JSON.stringify({ type: 'item.completed', item: todo(true) }) + '\n')

    const all = entries(store)
    expect(all).toHaveLength(1)
    expect(all[0].content).toContain('step one')
    expect(all[0].content).toContain('step two')
  })
})
