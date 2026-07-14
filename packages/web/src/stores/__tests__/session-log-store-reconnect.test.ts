import { beforeEach, describe, expect, it } from 'vitest'
import type { Operation } from 'fast-json-patch'
import type { NormalizedEntry } from '@agent-tower/shared/log-adapter'
import { useSessionLogStore } from '../session-log-store'

function entry(id: string, content = id): NormalizedEntry {
  return { id, timestamp: 0, entryType: 'assistant_message', content }
}

function addPatch(index: number, e: NormalizedEntry): Operation[] {
  return [{ op: 'add', path: `/entries/${index}`, value: e }]
}

/**
 * Socket 断线重连后的补快照序列：
 * useNormalizedLogs 重连时 fetch /logs 快照（带 seq），期间广播的 patch 进入缓冲，
 * 之后按 "seq <= 快照 seq 则跳过" 重放。这里验证 store 层的去重语义 ——
 * 它是防止重连后条目重复/丢失的最后防线。
 */
describe('sessionLogStore reconnect patch dedupe', () => {
  beforeEach(() => {
    useSessionLogStore.getState().clear()
  })

  it('skips patches already baked into the reconnect snapshot and applies newer ones', () => {
    const store = useSessionLogStore.getState()
    // 重连后拉到的权威快照：包含 seq<=5 的所有效果
    store.setConversation('s1', { entries: [entry('a'), entry('b')], seq: 5 })

    // 断线窗口内广播、快照已包含的 patch（seq=4、5）——必须跳过，否则 add 会重复插入
    expect(useSessionLogStore.getState().applyPatch('s1', addPatch(1, entry('b')), 4)).toBe(true)
    expect(useSessionLogStore.getState().applyPatch('s1', addPatch(1, entry('b')), 5)).toBe(true)
    // 快照之后的新 patch（seq=6）——必须应用
    expect(useSessionLogStore.getState().applyPatch('s1', addPatch(2, entry('c')), 6)).toBe(true)

    const conv = useSessionLogStore.getState().getConversation('s1')
    expect(conv?.entries.map((e) => e.id)).toEqual(['a', 'b', 'c'])
    expect(conv?.seq).toBe(6)
  })

  it('returns false for a session missing from the store so the caller can trigger a snapshot reload', () => {
    const ok = useSessionLogStore.getState().applyPatch('unknown', addPatch(0, entry('a')), 1)
    expect(ok).toBe(false)
  })

  it('returns false when a patch no longer fits the drifted local state (self-heal trigger)', () => {
    const store = useSessionLogStore.getState()
    store.setConversation('s1', { entries: [entry('a')], seq: 1 })

    // 服务端状态已领先本地（丢过事件），路径越界 → applyPatch 失败 → 调用方 reload 快照
    const ok = useSessionLogStore.getState().applyPatch(
      's1',
      [{ op: 'replace', path: '/entries/5/content', value: 'x' }],
      7,
    )

    expect(ok).toBe(false)
    // 失败的 patch 不得污染本地状态
    expect(useSessionLogStore.getState().getConversation('s1')?.entries.map((e) => e.id)).toEqual(['a'])
  })

  it('keeps seq when applying a patch without seq (legacy events cannot roll seq back)', () => {
    const store = useSessionLogStore.getState()
    store.setConversation('s1', { entries: [entry('a')], seq: 9 })

    expect(useSessionLogStore.getState().applyPatch('s1', addPatch(1, entry('b')))).toBe(true)
    expect(useSessionLogStore.getState().getConversation('s1')?.seq).toBe(9)
  })
})
