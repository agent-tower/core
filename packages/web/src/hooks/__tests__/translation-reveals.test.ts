import { expect, it } from 'vitest'
import { TranslationReveals } from '../translation-reveals'
const history = { id: 'history', revision: 1 }
const success = { id: 'history', version: 'source:1', state: 'SUCCESS' }

it('silences delayed historical success and its restoration after withdrawal', () => {
  const events = new TranslationReveals()
  events.update([], [], false)
  events.update([history], [], true)
  events.update([history], [success], true)
  expect(events.claim(success.version)).toBe(false)
  events.update([history], [], true)
  events.update([history], [success], true)
  expect(events.claim(success.version)).toBe(false)
})

it('plays one observed pending completion without replaying duplicate snapshots', () => {
  const events = new TranslationReveals()
  events.update([history], [{ ...success, state: 'RUNNING' }], true)
  events.update([history], [success], true)
  expect(events.claim(success.version)).toBe(true)
  events.update([history], [success], true)
  expect(events.claim(success.version)).toBe(false)
})

it('recognizes a fast newly added source even when its first REST read is SUCCESS', () => {
  const events = new TranslationReveals()
  events.update([history], [success], true)
  const added = { id: 'new', revision: 1 }, result = { id: 'new', version: 'new:1', state: 'SUCCESS' }
  events.update([history, added], [success, result], true)
  expect(events.claim(result.version)).toBe(true)
  expect(events.claim(success.version)).toBe(false)
})

it('recognizes an initially streaming source and a later content revision', () => {
  const events = new TranslationReveals()
  events.update([{ ...history, streaming: true }], [], true)
  events.update([history], [success], true)
  expect(events.claim(success.version)).toBe(true)
  events.update([{ ...history, revision: 2 }], [{ ...success, version: 'source:2' }], true)
  expect(events.claim('source:2')).toBe(true)
})
