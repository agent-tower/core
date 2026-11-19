import { describe, expect, it } from 'vitest'
import { ClaudeCodeParser, classifyClaudeTurnFailure } from '../claude-code-parser.js'
import { MsgStore } from '../msg-store.js'
import type { TurnFailureCause } from '../turn-failure.js'

// Shapes follow Claude Code 2.1.322 stream-json output. The values come from a
// real 5-hour stop on this host: resetsAt 1794993600 is 2026-11-18 09:20 UTC,
// shown as "resets 1:20am (America/Los_Angeles)".
const RESETS_AT = 1794993600
const RESETS_AT_ISO = '2026-11-18T09:20:00.000Z'
const LIMIT_TEXT = "You've hit your 5-hour limit · resets 1:20am (America/Los_Angeles)"

function feed(parser: ClaudeCodeParser, message: Record<string, unknown>) {
  parser.processData(JSON.stringify(message) + '\n')
}

function setup() {
  const parser = new ClaudeCodeParser(new MsgStore())
  const events: string[] = []
  const causes: TurnFailureCause[] = []
  parser.onTurnFailureCause((cause) => { causes.push(cause); events.push('cause') })
  parser.onTurnFailed(() => events.push('failed'))
  parser.onTurnCompleted(() => events.push('completed'))
  return { parser, causes, events }
}

function rateLimitEvent(status: string, extra: Record<string, unknown> = {}) {
  return { type: 'rate_limit_event', rate_limit_info: { status, resetsAt: RESETS_AT, rateLimitType: 'five_hour', ...extra }, uuid: 'rl', session_id: 's' }
}

function limitMessage(fields: Record<string, unknown>) {
  return {
    type: 'assistant',
    message: { id: 'synthetic-1', role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: LIMIT_TEXT }] },
    parent_tool_use_id: null,
    ...fields,
  }
}

function failedResult(extra: Record<string, unknown> = {}) {
  return { type: 'result', subtype: 'success', is_error: true, result: LIMIT_TEXT, num_turns: 1, result_index: 0, uuid: 'r0', origin: null, ...extra }
}

describe('Claude usage-limit stop', () => {
  it('reports the cause with the reset time before the turn-failed signal', () => {
    const { parser, causes, events } = setup()
    feed(parser, { type: 'system', subtype: 'init', session_id: 's' })
    feed(parser, rateLimitEvent('rejected'))
    feed(parser, limitMessage({
      error: 'rate_limit',
      api_error: 'usage_limit_reached',
      api_error_status: 429,
      api_error_params: { rate_limit_info: { status: 'rejected', resetsAt: RESETS_AT, rateLimitType: 'five_hour' } },
    }))
    feed(parser, failedResult({ api_error_status: 429, api_error: 'usage_limit_reached' }))
    expect(causes).toEqual([{ kind: 'usage_limit', resetsAt: RESETS_AT_ISO, limitType: 'five_hour', code: 'usage_limit_reached', message: LIMIT_TEXT }])
    expect(events).toEqual(['cause', 'failed'])
  })

  it('recognises the stop from public fields alone: rate_limit plus a rejected rate_limit_event', () => {
    const { parser, causes } = setup()
    feed(parser, rateLimitEvent('rejected', { rateLimitType: 'seven_day' }))
    feed(parser, limitMessage({ error: 'rate_limit' }))
    feed(parser, failedResult({ api_error_status: 429 }))
    expect(causes).toEqual([{ kind: 'usage_limit', resetsAt: RESETS_AT_ISO, limitType: 'seven_day', code: 'rate_limit', message: LIMIT_TEXT }])
  })

  it('recognises a per-model allowance (the Fable limit), whose text gives no reset time', () => {
    const { parser, causes } = setup()
    feed(parser, limitMessage({
      error: 'rate_limit',
      api_error: 'model_requires_usage_credits',
      api_error_params: { rate_limit_info: { status: 'rejected', resetsAt: 1794877200, rateLimitType: 'seven_day_overage_included' } },
      message: { id: 'synthetic-2', role: 'assistant', content: [{ type: 'text', text: "You've reached your Fable limit. Switch to another model, or manage usage credits." }] },
    }))
    feed(parser, failedResult())
    expect(causes).toHaveLength(1)
    expect(causes[0]).toMatchObject({ kind: 'usage_limit', resetsAt: '2026-11-17T01:00:00.000Z', limitType: 'seven_day_overage_included', code: 'model_requires_usage_credits' })
  })

  it('ignores a 429 that is not the account limit (no rejected subscription state)', () => {
    const { parser, causes, events } = setup()
    feed(parser, rateLimitEvent('allowed_warning'))
    feed(parser, limitMessage({ error: 'rate_limit' }))
    feed(parser, failedResult({ api_error_status: 429, result: 'API Error: Rate limited' }))
    expect(causes).toEqual([])
    expect(events).toEqual(['failed'])
  })

  it('ignores other failures and successful turns', () => {
    const { parser, causes } = setup()
    feed(parser, rateLimitEvent('rejected'))
    feed(parser, limitMessage({ error: 'server_error' }))
    feed(parser, failedResult({ api_error_status: 500, result: 'API Error: 500' }))
    feed(parser, { type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'done' }] } })
    feed(parser, { type: 'result', subtype: 'success', result: 'done', num_turns: 1, result_index: 1, uuid: 'r1', origin: { kind: 'task-notification' } })
    expect(causes).toEqual([])
  })

  it('reports a stop in a turn the CLI started itself after the delivered message', () => {
    const { parser, causes, events } = setup()
    feed(parser, { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'started a build in the background' }] } })
    feed(parser, { type: 'result', subtype: 'success', result: 'ok', num_turns: 1, result_index: 0, uuid: 'r0', origin: null })
    feed(parser, { type: 'system', subtype: 'init', session_id: 's' })
    feed(parser, rateLimitEvent('rejected'))
    feed(parser, limitMessage({ error: 'rate_limit', api_error: 'usage_limit_reached', api_error_params: { rate_limit_info: { status: 'rejected', resetsAt: RESETS_AT, rateLimitType: 'five_hour' } } }))
    feed(parser, failedResult({ result_index: 1, uuid: 'r1', origin: { kind: 'task-notification' } }))
    expect(events).toEqual(['completed', 'cause'])
    expect(causes[0]).toMatchObject({ kind: 'usage_limit', resetsAt: RESETS_AT_ISO })
  })

  it('does not carry an API error into the next turn', () => {
    const { parser, causes } = setup()
    feed(parser, limitMessage({ error: 'rate_limit', api_error: 'usage_limit_reached', api_error_params: { rate_limit_info: { status: 'rejected', resetsAt: RESETS_AT } } }))
    feed(parser, { type: 'result', subtype: 'success', result: 'recovered', num_turns: 1, result_index: 0, uuid: 'r0', origin: null })
    feed(parser, failedResult({ result_index: 1, uuid: 'r1', origin: { kind: 'task-notification' }, result: 'Tool failed' }))
    expect(causes).toEqual([])
  })
})

describe('classifyClaudeTurnFailure', () => {
  it('keeps the usage-limit kind but drops a reset time that is not Unix seconds', () => {
    const cause = classifyClaudeTurnFailure({
      result: { api_error: 'usage_limit_reached' },
      apiError: { error: 'rate_limit', apiError: 'usage_limit_reached', rateLimitInfo: { status: 'rejected', resetsAt: RESETS_AT * 1000 * 1000 }, text: null },
      rateLimitInfo: null,
    })
    expect(cause).toEqual({ kind: 'usage_limit', resetsAt: null, limitType: null, code: 'usage_limit_reached', message: null })
  })

  it('falls back to the rejected rate_limit_event when the error carries no reset time', () => {
    const cause = classifyClaudeTurnFailure({
      result: { api_error: 'usage_limit_reached', result: LIMIT_TEXT },
      apiError: null,
      rateLimitInfo: { status: 'rejected', resetsAt: RESETS_AT, rateLimitType: 'five_hour' },
    })
    expect(cause).toMatchObject({ resetsAt: RESETS_AT_ISO, limitType: 'five_hour', message: LIMIT_TEXT })
  })
})
