import { describe, expect, it } from 'vitest'
import { MsgStore } from '../msg-store.js'
import type { NormalizedConversation } from '../types.js'

/**
 * patch seq 是前端断线重连后去重补快照的唯一依据：
 * - 快照携带 seq，seq <= 快照 seq 的实时 patch 必须可安全跳过
 * - session 重启（restoreFromSnapshot）后 seq 必须延续而不是归零
 */
describe('MsgStore patch seq continuity', () => {
  it('assigns monotonically increasing seq and reports it in snapshots', () => {
    const store = new MsgStore()
    const seq1 = store.pushPatch([{ op: 'add', path: '/entries/0', value: { id: 'a', timestamp: 0, entryType: 'assistant_message', content: 'a' } }])
    const seq2 = store.pushPatch([{ op: 'replace', path: '/entries/0/content', value: 'a2' }])

    expect(seq2).toBe(seq1 + 1)
    expect(store.getSnapshot().seq).toBe(seq2)
  })

  it('continues seq from a restored snapshot instead of restarting at 1', () => {
    const store = new MsgStore()
    const persisted: NormalizedConversation = {
      entries: [
        { id: 'a', timestamp: 0, entryType: 'assistant_message', content: 'old' },
      ],
      seq: 41,
    }

    store.restoreFromSnapshot(persisted)
    const seq = store.pushPatch([
      { op: 'add', path: '/entries/1', value: { id: 'b', timestamp: 0, entryType: 'assistant_message', content: 'new' } },
    ])

    // 若 seq 归零重来，重连客户端会把新 patch 误判为"快照已包含"而丢弃
    expect(seq).toBe(42)
    const snapshot = store.getSnapshot()
    expect(snapshot.seq).toBe(42)
    expect(snapshot.entries.map((e) => e.content)).toEqual(['old', 'new'])
  })

  it('keeps the snapshot usable and seq advancing after an out-of-bounds patch fails to apply', () => {
    const store = new MsgStore()
    store.pushPatch([{ op: 'add', path: '/entries/0', value: { id: 'a', timestamp: 0, entryType: 'assistant_message', content: 'ok' } }])
    // 越界 replace（index 漂移场景）—— 服务端跳过该 patch 而不是损毁快照
    const badSeq = store.pushPatch([{ op: 'replace', path: '/entries/9/content', value: 'boom' }])
    const goodSeq = store.pushPatch([{ op: 'replace', path: '/entries/0/content', value: 'updated' }])

    const snapshot = store.getSnapshot()
    expect(snapshot.entries.map((e) => e.content)).toEqual(['updated'])
    // seq 依旧单调（失败的 patch 也占号），快照 seq 与最后一个 patch 对齐，
    // 前端 reload 后不会因 seq 回退而错乱
    expect(goodSeq).toBe(badSeq + 1)
    expect(snapshot.seq).toBe(goodSeq)
  })
})
