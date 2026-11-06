import { describe, expect, it, vi } from 'vitest'
import { ClaudeCodeParser, type ClaudeTurnBoundary } from '../claude-code-parser.js'
import { MsgStore } from '../msg-store.js'

function feed(parser: ClaudeCodeParser, message: Record<string, unknown>) {
  parser.processData(JSON.stringify(message) + '\n')
}

function setup() {
  const store = new MsgStore()
  const parser = new ClaudeCodeParser(store)
  const completed = vi.fn()
  const failed = vi.fn()
  const started = vi.fn()
  const boundaries: ClaudeTurnBoundary[] = []
  const tasks: string[][] = []
  parser.onTurnCompleted(completed)
  parser.onTurnFailed(failed)
  parser.onTurnStarted(started)
  parser.onTurnBoundary((boundary) => boundaries.push(boundary))
  parser.onBackgroundTasksChanged((list) => tasks.push(list.map((task) => task.taskId)))
  return { store, parser, completed, failed, started, boundaries, tasks }
}

describe('Claude Code print-mode run: delivery result, continuation turns and background work', () => {
  it('ignores the startup pseudo-turn result and closes the delivery on the first origin-null result', () => {
    const { store, parser, completed, boundaries } = setup()
    // Orphaned-task notice delivered by the CLI itself before our message is processed.
    feed(parser, { type: 'result', subtype: 'success', result: '', num_turns: 0, duration_api_ms: 0, result_index: 0, uuid: 'r0', origin: { kind: 'task-notification' }, usage: { input_tokens: 0 } })
    expect(completed).not.toHaveBeenCalled()
    expect(boundaries).toHaveLength(0)
    expect(store.getSnapshot().entries).toHaveLength(0)

    feed(parser, { type: 'system', subtype: 'init', session_id: 'native' })
    feed(parser, { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'answer' }], usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000 } } })
    feed(parser, { type: 'result', subtype: 'success', result: 'answer', num_turns: 1, result_index: 1, uuid: 'r1', origin: null, queued_turn_count: 0 })
    expect(completed).toHaveBeenCalledTimes(1)
    expect(boundaries).toEqual([{ kind: 'delivery', resultIndex: 1, origin: null, isFailure: false, queuedTurnCount: 0 }])
    expect(store.getSnapshot().entries.map((entry) => entry.entryType)).toEqual(['assistant_message', 'token_usage_info'])
  })

  it('treats a legacy result without origin as the delivery result', () => {
    const { parser, completed, boundaries } = setup()
    feed(parser, { type: 'result', subtype: 'success', result: 'done' })
    expect(completed).toHaveBeenCalledTimes(1)
    expect(boundaries[0]).toMatchObject({ kind: 'delivery', origin: null })
  })

  it('tracks background work from system events and announces task notifications', () => {
    const { store, parser, tasks } = setup()
    feed(parser, { type: 'system', subtype: 'init', session_id: 'native' })
    feed(parser, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'wait for router' }] })
    feed(parser, { type: 'system', subtype: 'task_started', task_id: 'b1', task_type: 'local_bash', description: 'wait for router', is_backgrounded: true })
    feed(parser, { type: 'system', subtype: 'task_started', task_id: 'fg', is_backgrounded: false })
    expect(parser.getBackgroundTasks()).toEqual([{ taskId: 'b1', description: 'wait for router', taskType: 'local_bash' }])
    feed(parser, { type: 'result', subtype: 'success', result: 'waiting', num_turns: 1, result_index: 0, uuid: 'r0', origin: null })
    feed(parser, { type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'completed', end_time: 1 } })
    expect(parser.getBackgroundTasks()).toEqual([])
    feed(parser, { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'Background command "wait for router" completed (exit code 0)' })
    feed(parser, { type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    expect(tasks).toEqual([['b1'], [], []])
    expect(store.getSnapshot().entries.at(-1)).toMatchObject({ entryType: 'system_message', content: 'Background command "wait for router" completed (exit code 0)' })
  })

  it('reports continuation turns of the same process without a second completion', () => {
    const { store, parser, completed, failed, started, boundaries } = setup()
    feed(parser, { type: 'system', subtype: 'init', session_id: 'native' })
    feed(parser, { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'WAITING' }], usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } } })
    feed(parser, { type: 'result', subtype: 'success', result: 'WAITING', num_turns: 2, result_index: 0, uuid: 'r0', origin: null })
    expect(started).toHaveBeenCalledTimes(1)
    expect(completed).toHaveBeenCalledTimes(1)

    feed(parser, { type: 'system', subtype: 'init', session_id: 'native' })
    expect(started).toHaveBeenCalledTimes(2)
    feed(parser, { type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'FINISHED' }], usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 } } })
    feed(parser, { type: 'result', subtype: 'success', result: 'FINISHED', num_turns: 1, result_index: 1, uuid: 'r1', origin: { kind: 'task-notification', producer: 'session-task' } })
    expect(completed).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
    expect(boundaries.map((boundary) => [boundary.kind, boundary.origin, boundary.resultIndex])).toEqual([
      ['delivery', null, 0],
      ['continuation', 'task-notification', 1],
    ])
    const types = store.getSnapshot().entries.map((entry) => entry.entryType)
    expect(types).toEqual(['assistant_message', 'token_usage_info', 'assistant_message', 'token_usage_info'])
    expect(store.getSnapshot().entries[3]).toMatchObject({ metadata: { tokenUsage: { totalTokens: 202 } } })
  })

  it('shows a continuation failure as an error without failing the delivered turn', () => {
    const { store, parser, completed, failed, boundaries } = setup()
    feed(parser, { type: 'result', subtype: 'success', result: 'ok', num_turns: 1, result_index: 0, uuid: 'r0', origin: null })
    feed(parser, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['API failed'], result_index: 1, uuid: 'r1', origin: { kind: 'task-notification' } })
    expect(completed).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
    expect(boundaries[1]).toMatchObject({ kind: 'continuation', isFailure: true })
    expect(store.getSnapshot().entries.at(-1)).toMatchObject({ entryType: 'error_message', content: 'API failed' })
  })
})
