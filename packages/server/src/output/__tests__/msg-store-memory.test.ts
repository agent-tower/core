/**
 * MsgStore 内存控制测试
 *
 * 防回归：
 * - streaming 同 path replace 不应导致内存 O(n²) 累积
 * - FIFO 驱逐时把被丢弃的 patch 折叠进 baseSnapshot，重建快照不能丢 entries
 * - patch apply 失败始终 warn（无 DEBUG_MSGSTORE 门控）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MsgStore } from '../msg-store.js'
import { createAssistantMessage, createUserMessage } from '../types.js'
import {
  addNormalizedEntry,
  updateEntryContent,
  replaceNormalizedEntry,
} from '../utils/patch.js'

describe('MsgStore: streaming dedup', () => {
  it('drops prior same-path replace ops to prevent quadratic growth', () => {
    const store = new MsgStore()
    const index = store.entryIndex.next()
    store.pushPatch(addNormalizedEntry(index, createAssistantMessage('')))

    // streaming：100 次累加，每次 replace 完整字符串
    let acc = ''
    for (let i = 0; i < 100; i++) {
      acc += 'token '
      store.pushPatch(updateEntryContent(index, acc))
    }

    const messages = store.getMessages()
    // 1 个 add + 1 个 replace（最新）；前 99 个 replace 应被 dedup 干掉
    expect(messages.length).toBe(2)
    expect(messages[0].type).toBe('patch')
    expect(messages[1].type).toBe('patch')

    // 最终快照仍正确
    const snap = store.getSnapshot()
    expect(snap.entries.length).toBe(1)
    expect(snap.entries[0].content).toBe(acc)
    expect(snap.seq).toBe(101)
  })

  it('non-adjacent same-path replace separated by stdout still dedups (slow path)', () => {
    // 模拟 PTY 流：每次 replace 之间夹着 stdout（跨 PTY chunk 场景）
    const store = new MsgStore()
    const idx = store.entryIndex.next()
    store.pushPatch(addNormalizedEntry(idx, createAssistantMessage('')))

    let acc = ''
    for (let i = 0; i < 50; i++) {
      acc += 'chunk '
      store.pushStdout('raw pty data ' + i)
      store.pushPatch(updateEntryContent(idx, acc))
    }

    const messages = store.getMessages()
    // 1 个 add + 50 stdout + 1 个最终 replace = 52
    // 前 49 个 replace 应该被 slow-path 全扫干掉
    const patchCount = messages.filter((m) => m.type === 'patch').length
    expect(patchCount).toBe(2)

    const snap = store.getSnapshot()
    expect(snap.entries[idx].content).toBe(acc)
  })

  it('keeps replace ops at distinct paths', () => {
    const store = new MsgStore()
    const i0 = store.entryIndex.next()
    const i1 = store.entryIndex.next()
    store.pushPatch(addNormalizedEntry(i0, createAssistantMessage('a')))
    store.pushPatch(addNormalizedEntry(i1, createAssistantMessage('b')))
    store.pushPatch(updateEntryContent(i0, 'a-updated'))
    store.pushPatch(updateEntryContent(i1, 'b-updated'))

    const messages = store.getMessages()
    // 2 add + 2 replace（不同 path），都保留
    expect(messages.length).toBe(4)

    const snap = store.getSnapshot()
    expect(snap.entries[i0].content).toBe('a-updated')
    expect(snap.entries[i1].content).toBe('b-updated')
  })

  it('full-entry replace at /entries/N also dedups prior same-path replace', () => {
    const store = new MsgStore()
    const idx = store.entryIndex.next()
    store.pushPatch(addNormalizedEntry(idx, createAssistantMessage('initial')))
    store.pushPatch(replaceNormalizedEntry(idx, createAssistantMessage('v1')))
    store.pushPatch(replaceNormalizedEntry(idx, createAssistantMessage('v2')))
    store.pushPatch(replaceNormalizedEntry(idx, createAssistantMessage('final')))

    const messages = store.getMessages()
    expect(messages.length).toBe(2) // 1 add + 1 final replace

    const snap = store.getSnapshot()
    expect(snap.entries[idx].content).toBe('final')
  })
})

describe('MsgStore: FIFO eviction folds into baseSnapshot', () => {
  it('rebuilds correct snapshot after evicting oldest add patches', () => {
    const store = new MsgStore()

    // 用 stdout 模拟内存压力（不被 dedup 影响），间插 add patches
    // 通过私有访问做小批量验证：直接调用 push 推 patch，再注入大 stdout 驱逐
    const i0 = store.entryIndex.next()
    const i1 = store.entryIndex.next()
    const i2 = store.entryIndex.next()
    store.pushPatch(addNormalizedEntry(i0, createUserMessage('hello')))
    store.pushPatch(addNormalizedEntry(i1, createAssistantMessage('hi')))
    store.pushPatch(addNormalizedEntry(i2, createUserMessage('thanks')))

    // 推一个超大 stdout 强制驱逐前面所有 messages
    // MAX_MEMORY_BYTES = 100 * 1024 * 1024 → push 一个 60MB stdout 不触发，
    // 推两个就压破。第二次 push 时驱逐前面所有较小的 add patches。
    const huge = 'x'.repeat(30 * 1024 * 1024) // 60MB after *2
    store.pushStdout(huge)
    store.pushStdout(huge)
    store.pushStdout(huge) // 总共 180MB，强制丢弃所有

    const snap = store.getSnapshot()
    // 关键断言：尽管 add patches 被驱逐，entries 仍完整
    expect(snap.entries.length).toBe(3)
    expect(snap.entries[0].content).toBe('hello')
    expect(snap.entries[1].content).toBe('hi')
    expect(snap.entries[2].content).toBe('thanks')
  })

  it('preserves entries when evicted patches include both add and replace', () => {
    const store = new MsgStore()
    const idx = store.entryIndex.next()
    store.pushPatch(addNormalizedEntry(idx, createAssistantMessage('start')))
    store.pushPatch(updateEntryContent(idx, 'middle'))
    store.pushPatch(updateEntryContent(idx, 'end'))

    const huge = 'x'.repeat(35 * 1024 * 1024)
    store.pushStdout(huge)
    store.pushStdout(huge)
    store.pushStdout(huge)

    const snap = store.getSnapshot()
    expect(snap.entries.length).toBe(1)
    expect(snap.entries[0].content).toBe('end')
  })

  it('preserves sessionId across eviction', () => {
    const store = new MsgStore()
    const idx = store.entryIndex.next()
    store.pushSessionId('agent-session-abc')
    store.pushPatch(addNormalizedEntry(idx, createUserMessage('q1')))

    const huge = 'x'.repeat(35 * 1024 * 1024)
    store.pushStdout(huge)
    store.pushStdout(huge)
    store.pushStdout(huge)

    const snap = store.getSnapshot()
    expect(snap.sessionId).toBe('agent-session-abc')
    expect(snap.entries.length).toBe(1)
    expect(snap.entries[0].content).toBe('q1')
  })
})

describe('MsgStore: warnings always fire on apply errors', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('logs warn when full rebuild encounters bad patch', () => {
    const store = new MsgStore()
    // 直接 push 一个无效 patch（path 不存在）
    store.pushPatch([{ op: 'replace', path: '/entries/99/content', value: 'oops' }])
    // 触发全量重建（getSnapshot 第一次走完整路径）
    store.getSnapshot()
    expect(warnSpy).toHaveBeenCalled()
    expect(warnSpy.mock.calls[0][0]).toContain('full patch apply failed')
  })
})
