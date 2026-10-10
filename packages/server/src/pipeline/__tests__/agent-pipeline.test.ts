import { describe, expect, it, vi } from 'vitest'
import type { IPty } from '@shitiandmw/node-pty'
import { AgentPipeline, type OutputParser } from '../agent-pipeline.js'
import { MsgStore } from '../../output/msg-store.js'
import { CodexParser } from '../../output/codex-parser.js'
import { EventBus } from '../../core/event-bus.js'
import { ClaudeCodeParser } from '../../output/claude-code-parser.js'
import type { CliDuplexEvent, CliDuplexIO } from '../../utils/cli-duplex-channel.js'

/**
 * 最小可控 PTY：手动触发 data/exit，模拟 node-pty 的事件语义
 * （事件不重放；exit 后不再有 data）。
 */
class FakePty {
  killed = false
  written: string[] = []
  private dataListeners: Array<(data: string) => void> = []
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = []

  onData = (listener: (data: string) => void) => {
    this.dataListeners.push(listener)
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter((l) => l !== listener)
      },
    }
  }

  onExit = (listener: (e: { exitCode: number; signal?: number }) => void) => {
    this.exitListeners.push(listener)
    return {
      dispose: () => {
        this.exitListeners = this.exitListeners.filter((l) => l !== listener)
      },
    }
  }

  emitData(data: string) {
    for (const l of [...this.dataListeners]) l(data)
  }

  emitExit(exitCode: number) {
    for (const l of [...this.exitListeners]) l({ exitCode })
  }

  write(data: string) {
    this.written.push(data)
  }

  resize() {}

  kill() {
    this.killed = true
  }

  asIPty(): IPty {
    return this as unknown as IPty
  }
}

function codexLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n'
}

function agentMessage(id: string, text: string) {
  return { type: 'item.completed', item: { id, type: 'agent_message', text } }
}

function setup() {
  const pty = new FakePty()
  const msgStore = new MsgStore()
  const parser = new CodexParser(msgStore)
  const eventBus = new EventBus()
  const patches: Array<{ patch: unknown[]; seq: number }> = []
  const exits: Array<number | undefined> = []
  eventBus.on('session:patch', ({ patch, seq }) => patches.push({ patch, seq }))
  eventBus.on('session:exit', ({ exitCode }) => exits.push(exitCode))
  const pipeline = new AgentPipeline('session-1', pty.asIPty(), parser, msgStore, eventBus)
  return { pty, msgStore, parser, eventBus, patches, exits, pipeline }
}

describe('AgentPipeline end-to-end data flow', () => {
  it('retains the duplex reader after PTY exit until delayed result/usage and EOF arrive', async () => {
    const pty = new FakePty(); const msgStore = new MsgStore(); const bus = new EventBus()
    const parser = new ClaudeCodeParser(msgStore); const finish = vi.spyOn(parser, 'finish')
    let reader: ((event: CliDuplexEvent) => void) | undefined
    const io: CliDuplexIO = { subscribe: next => { reader = next; return () => { reader = undefined } }, write: async () => {}, end: async () => {}, close: () => reader?.({ type: 'disconnected', error: new Error('closed') }) }
    const exits: number[] = []; bus.on('session:exit', e => exits.push(e.exitCode!))
    const pipeline = new AgentPipeline('session-1', pty.asIPty(), parser, msgStore, bus, undefined, io)
    pty.emitExit(0)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(finish).not.toHaveBeenCalled(); expect(exits).toEqual([]); expect(pipeline.isAlive).toBe(true)
    reader!({ type: 'stdout', data: JSON.stringify({ type: 'assistant', message: { id: 'late', content: [{ type: 'text', text: 'final result' }], usage: { input_tokens: 17, output_tokens: 9 } } }) + '\n' })
    reader!({ type: 'stdout', data: JSON.stringify({ type: 'result', subtype: 'success', modelUsage: { test: { contextWindow: 200000 } } }) + '\n' })
    expect(finish).not.toHaveBeenCalled()
    reader!({ type: 'eof' })
    expect(finish).toHaveBeenCalledTimes(1); expect(exits).toEqual([0]); expect(pipeline.isAlive).toBe(false)
    expect(msgStore.getSnapshot().entries.map(e => e.content)).toContain('final result')
    expect(msgStore.getSnapshot().entries.find(e => e.entryType === 'token_usage_info')?.metadata?.tokenUsage?.totalTokens).toBe(17)
  })

  it('bounds a missing duplex EOF and releases the reader on transport failure', () => {
    vi.useFakeTimers()
    try {
      const pty = new FakePty(); const parser = { processData: vi.fn(), finish: vi.fn() }
      let reader: ((event: CliDuplexEvent) => void) | undefined
      const close = vi.fn(() => reader?.({ type: 'disconnected', error: new Error('timeout') }))
      const io: CliDuplexIO = { subscribe: next => { reader = next; return () => { reader = undefined } }, write: async () => {}, end: async () => {}, close }
      const pipeline = new AgentPipeline('session-1', pty.asIPty(), parser, new MsgStore(), new EventBus(), undefined, io)
      pty.emitExit(1); vi.advanceTimersByTime(10_000)
      expect(close).toHaveBeenCalledOnce(); expect(parser.finish).toHaveBeenCalledOnce(); expect(pipeline.isAlive).toBe(false); expect(reader).toBeUndefined()
    } finally { vi.useRealTimers() }
  })
  it('forwards parsed patches with monotonic seq and resumes after long silence between chunks', () => {
    const { pty, msgStore, patches } = setup()

    pty.emitData(codexLine(agentMessage('m1', 'before silence')))
    // —— 长时间静默（无任何 data）后恢复输出 ——
    pty.emitData(codexLine(agentMessage('m2', 'after silence')))

    const contents = msgStore.getSnapshot().entries.map((e) => e.content)
    expect(contents).toEqual(['before silence', 'after silence'])

    const seqs = patches.map((p) => p.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(msgStore.getSnapshot().seq).toBe(seqs[seqs.length - 1])
  })

  it('parses a JSON line split across chunks arriving far apart', () => {
    const { pty, msgStore } = setup()
    const line = codexLine(agentMessage('m1', 'split across pty chunks'))

    pty.emitData(line.slice(0, 18))
    pty.emitData(line.slice(18))

    expect(msgStore.getSnapshot().entries.map((e) => e.content)).toEqual([
      'split across pty chunks',
    ])
  })

  it('emits exactly one entry when the process exits with an unterminated final line, even after SessionManager destroy()', () => {
    const { pty, msgStore, exits, pipeline } = setup()

    // 最后一行没有换行（进程 crash / 被 kill 的典型输出形态）
    pty.emitData(JSON.stringify(agentMessage('m1', 'final flush')))
    pty.emitExit(0)
    // SessionManager 的 session:exit handler 会再次 destroy —— 不能重复 finish
    pipeline.destroy()

    const msgs = msgStore.getSnapshot().entries.filter((e) => e.entryType === 'assistant_message')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('final flush')
    expect(exits).toEqual([0])
    expect(msgStore.isFinished()).toBe(true)
  })

  it('surfaces stderr-only output as an error entry on non-zero exit (full chain)', () => {
    const { pty, msgStore, exits, patches } = setup()

    pty.emitData('ERROR: stream disconnected before completion\n')
    pty.emitExit(1)

    const errors = msgStore.getSnapshot().entries.filter((e) => e.entryType === 'error_message')
    expect(errors).toHaveLength(1)
    expect(errors[0].content).toContain('stream disconnected')
    expect(exits).toEqual([1])
    // 错误 entry 的 patch 必须在 session:exit 前推给前端
    expect(patches.length).toBeGreaterThan(0)
  })

  it('keeps raw stdout flowing into MsgStore and completes the exit flow when the parser throws', () => {
    const pty = new FakePty()
    const msgStore = new MsgStore()
    const eventBus = new EventBus()
    const exits: Array<number | undefined> = []
    eventBus.on('session:exit', ({ exitCode }) => exits.push(exitCode))
    const throwingParser: OutputParser = {
      processData() {
        throw new Error('parser bug')
      },
      finish() {
        throw new Error('parser bug in finish')
      },
    }
    new AgentPipeline('session-1', pty.asIPty(), throwingParser, msgStore, eventBus)

    // parser 抛错不能传播到 PTY 回调（会变成 uncaughtException 杀死整个服务）
    expect(() => pty.emitData('some output\n')).not.toThrow()
    expect(() => pty.emitExit(1)).not.toThrow()

    // 原始 stdout 仍然保留，session:exit 仍然发出 —— 会话不会永远停在 RUNNING
    const stdout = msgStore.getMessages().filter((m) => m.type === 'stdout')
    expect(stdout).toHaveLength(1)
    expect(exits).toEqual([1])
    expect(msgStore.isFinished()).toBe(true)
  })

  it('still emits patches flushed from the parser buffer during destroy() (stop path)', () => {
    const { pty, msgStore, patches, pipeline } = setup()

    // 半行输出后用户点了 Stop —— destroy 时 flush 出的 entry 必须实时推送
    pty.emitData(JSON.stringify(agentMessage('m1', 'flushed on stop')))
    const patchesBefore = patches.length
    pipeline.destroy()

    expect(msgStore.getSnapshot().entries.map((e) => e.content)).toEqual(['flushed on stop'])
    expect(patches.length).toBeGreaterThan(patchesBefore)
    expect(pty.killed).toBe(true)
  })

  it('ignores data arriving after exit (current contract: destroyed pipeline drops late chunks)', () => {
    const { pty, msgStore } = setup()

    pty.emitData(codexLine(agentMessage('m1', 'in time')))
    pty.emitExit(0)
    pty.emitData(codexLine(agentMessage('m2', 'too late')))

    expect(msgStore.getSnapshot().entries.map((e) => e.content)).toEqual(['in time'])
  })

  it('replays early PTY events (spawn→attach race) so a fast-exiting process still completes the session', () => {
    // 进程在 executor.spawn 返回后、pipeline attach 前就输出并退出
    // （activateSpawnedSession 的 DB 事务窗口）。node-pty 不重放事件，
    // 未重放时该会话将永远收不到 session:exit —— 永久 RUNNING。
    const pty = new FakePty()
    const msgStore = new MsgStore()
    const parser = new CodexParser(msgStore)
    const eventBus = new EventBus()
    const exits: Array<number | undefined> = []
    eventBus.on('session:exit', ({ exitCode }) => exits.push(exitCode))

    const pipeline = new AgentPipeline('session-1', pty.asIPty(), parser, msgStore, eventBus, [
      { type: 'data', data: codexLine({ type: 'thread.started', thread_id: 'thread-abc' }) },
      { type: 'data', data: 'codex: unexpected argument\n' },
      { type: 'exit', exitCode: 2 },
    ])

    // 早期 stdout 进入 parser：sessionId 不丢，resume 才能续接
    expect(msgStore.getSnapshot().sessionId).toBe('thread-abc')
    // 早期 exit 完整走完退出流程
    expect(exits).toEqual([2])
    expect(msgStore.isFinished()).toBe(true)
    // 非 JSON 输出 + 非零退出 → 错误 entry 对用户可见
    const errors = msgStore.getSnapshot().entries.filter((e) => e.entryType === 'error_message')
    expect(errors).toHaveLength(1)
    expect(errors[0].content).toContain('unexpected argument')
    // pipeline 已自毁，SessionManager 不得将其视为活跃
    expect(pipeline.isAlive).toBe(false)
  })

  it('forwards Codex logical completion before a still-running PTY exits', () => {
    const { pty, msgStore, eventBus, pipeline } = setup()
    const completions: string[] = []
    eventBus.on('session:turn-completed', ({ sessionId }) => completions.push(sessionId))

    pty.emitData(codexLine(agentMessage('m1', 'done')))
    pty.emitData(codexLine({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }))

    expect(completions).toEqual(['session-1'])
    expect(msgStore.getSnapshot().entries.map((entry) => entry.content)).toContain('done')
    expect(msgStore.isFinished()).toBe(true)
    expect(pipeline.isAlive).toBe(true)
  })

  it('forwards one failed-turn signal and ignores a later zero exit', () => {
    const { pty, msgStore, eventBus, pipeline } = setup()
    const failures: string[] = []
    const completions: string[] = []
    eventBus.on('session:turn-failed', ({ sessionId }) => failures.push(sessionId))
    eventBus.on('session:turn-completed', ({ sessionId }) => completions.push(sessionId))

    const failed = codexLine({ type: 'turn.failed', error: { message: 'provider unavailable' } })
    pty.emitData(failed)
    pty.emitData(failed)
    pty.emitData(codexLine({ type: 'turn.completed' }))
    pty.emitExit(0)

    expect(failures).toEqual(['session-1'])
    expect(completions).toEqual([])
    expect(msgStore.getSnapshot().entries.map((entry) => entry.content)).toContain('provider unavailable')
    expect(msgStore.isFinished()).toBe(true)
    expect(pipeline.isAlive).toBe(false)
  })
})
