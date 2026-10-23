// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageDelivery, SessionMessageDelivery, SessionTranslationOverlay } from '@agent-tower/shared'
import { LogType, type LogEntry } from '@agent-tower/shared/log-adapter'
import { apiClient, ApiError } from '@/lib/api-client'
import { LogStream } from '../LogStream'
import { mergeDeliveryLogs } from '@/lib/delivery-logs'
import { CopyTranslationText } from '../TranslationComparison'

const state = vi.hoisted(() => ({ overlays: [] as SessionTranslationOverlay[], enabled: true, sessions: [] as string[] }))
vi.mock('@/hooks/use-session-translations', async original => ({ ...await original<typeof import('@/hooks/use-session-translations')>(), useSessionTranslations: (id: string) => { state.sessions.push(id); return { overlays: state.overlays } } }))
vi.mock('@/hooks/use-translation-settings', async original => ({ ...await original<typeof import('@/hooks/use-translation-settings')>(), useTranslationSettings: () => ({ data: { enabled: state.enabled, sendTargetLanguage: 'English', displayTargetLanguage: 'Chinese' }, isError: false }) }))
vi.mock('@/lib/api-client', async original => ({ ...await original<typeof import('@/lib/api-client')>(), apiClient: { post: vi.fn(), get: vi.fn() } }))
vi.mock('@/lib/socket/manager', () => ({ socketManager: { connect: () => ({ on: vi.fn(), off: vi.fn() }) } }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (value: string) => value }) }))
vi.mock('streamdown', () => ({ Streamdown: ({ children }: { children: React.ReactNode }) => <div data-markdown>{children}</div> }))
vi.mock('@streamdown/mermaid', () => ({ mermaid: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const original = 'Original long answer\n\n[report](report.md)\n\n' + 'More original content. '.repeat(80)
const translated = 'Translated answer\n\n[report](report.md)'
const log: LogEntry = { id: 'body-a', type: LogType.Assistant, content: original, textBlock: { turnId: 'actual-turn', runtimeGeneration: 'g', streamId: 'stream', blockId: 'block-a', sourceRevision: 4, state: 'SEALED', semanticType: 'assistant_message' } }
const overlay: SessionTranslationOverlay = { sourceId: 'source-a', sessionId: 'actual-session', turnId: 'actual-turn', blockId: 'block-a', sourceRevision: 4, overlayRevision: 19, state: 'SUCCESS', originalText: original, translatedText: translated, targetLanguage: 'Chinese', errorCode: null }
let client: QueryClient
let root: Root
let container: HTMLDivElement
const clipboard = vi.fn().mockResolvedValue(undefined)
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
async function render(logs: LogEntry[] = [log], sessionId = 'actual-session') { act(() => root.render(<QueryClientProvider client={client}><LogStream logs={logs} sessionId={sessionId} /></QueryClientProvider>)); await flush() }
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
  if (!found) throw new Error(`Missing button ${label}`)
  return found
}
beforeEach(() => {
  vi.clearAllMocks(); state.enabled = true; state.overlays = [overlay]; state.sessions = []
  vi.mocked(apiClient.get).mockResolvedValue({ items: [], nextCursor: null })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear() })

describe('User delivery translation indicator', () => {
  const submission = (origin: 'TASK_FOLLOWUP' | 'CONVERSATION'): SessionMessageDelivery => ({
    ...(origin === 'CONVERSATION'
      ? { origin, sessionId: 'actual-session', conversationId: 'conversation', destination: { kind: 'CONVERSATION', sessionId: 'actual-session', conversationId: 'conversation' } }
      : { origin, sessionId: 'actual-session', conversationId: null, destination: { kind: 'SESSION', sessionId: 'actual-session' } }),
    id: 'user-delivery', clientSubmissionId: 'submission', channelKey: 'channel', sequence: 1, originalText: 'User original', attachmentIds: [],
    state: 'READY', sentMode: 'ORIGINAL', acceptedText: 'User original', actualSentText: null, sentAt: null, acceptedDestinationId: null,
    lastError: null, revision: 1, createdAt: new Date(10).toISOString(),
  })
  function restore(getDelivery: () => SessionMessageDelivery) {
    vi.mocked(apiClient.get).mockImplementation(async (url, options) => {
      const item = getDelivery()
      if (url !== '/message-deliveries') return item
      const sent = item.state === 'SENT'
      return { items: (options?.params?.filter === 'sent') === sent ? [item] : [], nextCursor: null }
    })
  }

  it.each(['TASK_FOLLOWUP', 'CONVERSATION'] as const)('hides original-send indicators in %s while pending, sent and restored with saved languages', async origin => {
    state.enabled = false; state.overlays = []
    let item = submission(origin)
    restore(() => item)
    await render([])
    expect(container.textContent).toContain('User original')
    expect(container.textContent).not.toContain('Waiting to send')
    expect(container.textContent).not.toContain('Send original')
    expect(container.textContent).not.toContain('Cancel')
    expect(container.querySelector('[aria-haspopup="dialog"]')).toBeNull()

    item = { ...item, state: 'SENT', actualSentText: item.originalText, revision: 2 }
    await act(async () => { await client.invalidateQueries({ queryKey: ['message-deliveries'] }) })
    const formal: LogEntry = { id: 'formal-user', deliveryId: item.id, type: LogType.User, content: item.originalText }
    await render([formal])
    expect(container.querySelectorAll('[data-markdown]')).toHaveLength(1)
    expect(container.querySelector('[aria-haspopup="dialog"]')).toBeNull()

    // A fresh query cache must make the same decision from the stored receipt.
    act(() => root.render(<></>)); client.clear()
    await render([formal])
    expect(container.textContent).toContain(item.originalText)
    expect(container.querySelector('[aria-haspopup="dialog"]')).toBeNull()
    state.enabled = true; await render([formal])
    expect(container.querySelector('[aria-haspopup="dialog"]')).toBeNull()
  })

  it('keeps translation waiting feedback and a genuine translated receipt after disabling', async () => {
    state.overlays = []
    let item: SessionMessageDelivery = { ...submission('TASK_FOLLOWUP'), state: 'WAITING_TRANSLATION', sentMode: null, acceptedText: null }
    restore(() => item)
    await render([])
    expect(container.textContent).toContain('Waiting for translation')
    expect(container.querySelector('[aria-haspopup="dialog"]')).toBeNull()
    // Equal output is still a real translation; the receipt mode owns this fact.
    item = { ...item, state: 'SENT', sentMode: 'TRANSLATED', actualSentText: item.originalText, revision: 2 }
    await act(async () => { await client.invalidateQueries({ queryKey: ['message-deliveries'] }) })
    await render([])
    expect(button('Actual sent text').closest('[data-message-feedback]')).not.toBeNull()
    state.enabled = false; await render([])
    act(() => button('Actual sent text').click()); await flush()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(item.actualSentText)
  })
})

describe('Assistant translation display', () => {
  it('shows translated paragraphs together with a live original tail in the same message', async () => {
    const prefix = 'First completed paragraph. '.repeat(12) + '\n\n'
    const partial: LogEntry = { ...log, content: prefix + 'Tail still streaming', textBlock: {
      ...log.textBlock!, state: 'OPEN', paragraphs: [{ end: prefix.length, translationEpoch: 1 }],
    } }
    state.overlays = [{ ...overlay, blockId: 'block-a:p0', originalText: prefix, translatedText: '第一段译文。\n\n' }]
    await render([partial])
    expect(container.querySelector('[data-markdown]')?.textContent).toBe('第一段译文。\n\nTail still streaming')
    await render([{ ...partial, content: prefix + 'Tail still streaming and growing' }])
    expect(container.querySelector('[data-markdown]')?.textContent).toBe('第一段译文。\n\nTail still streaming and growing')
    act(() => button('Original').click()); await flush()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(prefix + 'Tail still streaming and growing')
    // A revision invalidates the whole old prefix immediately, before a new REST response.
    await render([{ ...partial, content: 'Corrected reply', textBlock: { ...partial.textBlock!, sourceRevision: 5, paragraphs: undefined } }])
    expect(container.querySelector('[data-markdown]')?.textContent).toBe('Corrected reply')
    expect(container.querySelector('[data-markdown]')?.textContent).not.toContain('第一段译文')
  })

  it('keeps a completed paragraph visible when the following paragraph fails', async () => {
    const prefix = 'First paragraph\n\n'
    const body: LogEntry = { ...log, content: prefix + 'Second paragraph', textBlock: {
      ...log.textBlock!, paragraphs: [{ end: prefix.length, translationEpoch: 1 }],
    } }
    state.overlays = [
      { ...overlay, blockId: 'block-a:p0', originalText: prefix, translatedText: '第一段\n\n' },
      { ...overlay, sourceId: 'source-b', blockId: 'block-a:p1', originalText: 'Second paragraph', translatedText: null, state: 'FAILED', errorCode: 'TIMEOUT' },
    ]
    await render([body])
    expect(container.querySelector('[data-markdown]')?.textContent).toBe('第一段\n\nSecond paragraph')
    act(() => button('Original').click()); await flush()
    act(() => button('Retry translation').click()); await flush()
    expect(apiClient.post).toHaveBeenCalledWith('/sessions/actual-session/translations/source-b/retry', { expectedRevision: 4 })
  })

  it('projects waiting/failed first input once and adopts the formal log by delivery identity', () => {
    const delivery = { id: 'outgoing', originalText: 'First original', state: 'TRANSLATION_FAILED', createdAt: new Date(10).toISOString() } as MessageDelivery
    const waiting = mergeDeliveryLogs([], [delivery])
    expect(waiting).toMatchObject([{ id: 'user:outgoing', deliveryId: 'outgoing', type: LogType.User, content: 'First original' }])
    const formal = { ...waiting[0], timestamp: 20 }
    expect(mergeDeliveryLogs([formal, log], [delivery])).toEqual([formal, log])
    expect(mergeDeliveryLogs([], [delivery, { ...delivery, id: 'second' }])).toHaveLength(2)
    expect(mergeDeliveryLogs([], [{ ...delivery, state: 'CANCELLED' }])).toEqual([])
  })

  it('keeps tool/thinking content intact and translates a sealed body in place while a later tool is still active', async () => {
    const logs: LogEntry[] = [log, { id: 'thinking', type: LogType.Assistant, title: 'Thinking', content: 'Thinking: plan in English' },
      { id: 'tool', type: LogType.Tool, content: 'original tool output', title: 'Long running tool', tool: { action: 'tool', id: 'tool', name: 'shell', status: 'in_progress' as const } }]
    await render(logs)
    expect(container.textContent).toContain(translated)
    expect(container.textContent).toContain('plan in English')
    expect(container.textContent).not.toContain('More original content.')
    expect(container.querySelector('[data-at-row="legacy:body-a"]')).not.toBeNull()
    expect(state.sessions).toContain('actual-session')
  })

  it('preserves historical success when disabled and compares only the original outside the translated body', async () => {
    state.enabled = false
    await render()
    act(() => button('Original').click()); await flush()
    const trigger = button('Original')
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain(original)
    expect(dialog.textContent).not.toContain(translated)
    expect(dialog.querySelectorAll('button[aria-label^="Copy"]')).toHaveLength(1)
    expect(dialog.querySelector('[tabindex="0"]')?.className).toContain('overflow-y-auto')
    act(() => button('Copy original').click()); await flush()
    expect(clipboard).toHaveBeenLastCalledWith(original)
    act(() => button('关闭').click()); await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('allows keyboard entry and Escape back to the trigger without trapping outside focus on dismissal', async () => {
    await render()
    const trigger = button('Original')
    act(() => trigger.focus()); await flush()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    act(() => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))); await flush()
    expect(document.activeElement).toBe(button('Copy original'))
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await flush()
    expect(document.activeElement).toBe(trigger)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    act(() => trigger.click()); await flush()
    const outside = document.createElement('input'); document.body.append(outside)
    act(() => { outside.focus(); outside.dispatchEvent(new Event('focusin', { bubbles: true })) }); await flush()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it.each([
    ['FAILED', 'AUTH_FAILED', 'Translation credential was rejected. Check the API key.'],
    ['RETRY_WAIT', 'TIMEOUT', 'The translation request timed out. Try again.'],
    ['INTERRUPTED', 'PROTECTION_FAILED', 'The translation changed protected content. The original is preserved.'],
    ['FAILED', 'UNKNOWN_ERROR', 'Translation request failed. Check the service and try again.'],
    ['FAILED', null, 'Translation request failed. Check the service and try again.'],
  ] as const)('shows the returned %s failure reason for %s in the original comparison', async (status, errorCode, reason) => {
    state.overlays = [{ ...overlay, state: status, errorCode, translatedText: null }]
    await render()
    expect(container.textContent).toContain(original)
    act(() => button('Original').click()); await flush()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain(reason)
    if (errorCode) expect(dialog.textContent).toContain(errorCode)
  })

  it('retains failure details when disabled and removes them when the overlay resumes or succeeds', async () => {
    const errorCode = 'AUTH_FAILED'
    const reason = 'Translation credential was rejected. Check the API key.'
    state.overlays = [{ ...overlay, state: 'FAILED', errorCode, translatedText: null }]
    await render()
    act(() => button('Original').click()); await flush()
    state.enabled = false; await render()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(reason)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(errorCode)
    expect([...document.querySelectorAll('button')].some(item => item.textContent === 'Retry translation')).toBe(false)

    for (const status of ['RUNNING', 'SUCCESS'] as const) {
      state.overlays = [{ ...overlay, state: status, errorCode }]
      await render()
      act(() => button('Original').click()); await flush()
      const dialog = document.querySelector('[role="dialog"]')!
      expect(dialog.textContent).not.toContain(reason)
      expect(dialog.textContent).not.toContain(errorCode)
      if (status === 'RUNNING') expect(dialog.textContent).toContain('Translating…')
      else expect(container.textContent).toContain(translated)
    }
  })

  it('retries only the failed sealed source using sourceRevision; 409 refreshes without replay', async () => {
    state.overlays = [{ ...overlay, state: 'FAILED', translatedText: null }]
    vi.mocked(apiClient.post).mockRejectedValue(new ApiError(409, 'changed'))
    const invalidated = vi.spyOn(client, 'invalidateQueries')
    await render()
    expect(container.textContent).toContain(original)
    act(() => button('Original').click()); await flush()
    act(() => button('Retry translation').click()); await flush()
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith('/sessions/actual-session/translations/source-a/retry', { expectedRevision: 4 })
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ['session-translations', 'actual-session'] })
    state.enabled = false; await render()
    expect([...document.querySelectorAll('button')].some(item => item.textContent === 'Retry translation')).toBe(false)
    expect(apiClient.post).toHaveBeenCalledTimes(1)
  })

  it('uses original for NOT_REQUIRED, revised/open bodies and another Session, without false translated labels', async () => {
    state.overlays = [{ ...overlay, state: 'NOT_REQUIRED' }]; await render()
    expect(container.textContent).toContain(original)
    expect(container.textContent).not.toContain('Translated')
    state.overlays = [overlay]
    await render([{ ...log, textBlock: { ...log.textBlock!, state: 'OPEN' } }])
    expect(container.textContent).not.toContain(translated)
    await render([{ ...log, content: 'new original' }])
    expect(container.textContent).toContain('new original')
    expect(container.textContent).not.toContain(translated)
    await render([log], 'other-session')
    expect(container.textContent).not.toContain(translated)
  })

  it('supports copying without Clipboard API and reports fallback failure accurately', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const copied: string[] = []
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => { copied.push((document.activeElement as HTMLTextAreaElement).value); return true }) })
    act(() => root.render(<CopyTranslationText text={'exact original bytes\n'} label="copy" />))
    act(() => button('copy').click()); await flush()
    expect(copied).toEqual(['exact original bytes\n'])
    expect(container.textContent).toContain('已复制')
    vi.mocked(document.execCommand).mockReturnValue(false)
    act(() => button('copy').click()); await flush()
    expect(container.textContent).toContain('Copy failed.')
  })
})


it('distinguishes asynchronous history from one live completion across streaming, recovery and session switches', async () => {
  const animate = vi.fn(() => ({ cancel: vi.fn() }))
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate })
  state.overlays = []; await render()
  state.overlays = [overlay]; await render()
  expect(animate).not.toHaveBeenCalled()
  state.overlays = [{ ...overlay, sourceId: 'retry-source', state: 'RUNNING', translatedText: null }]; await render()
  const outside = document.createElement('textarea'); document.body.append(outside); outside.focus()
  state.overlays = [{ ...overlay, sourceId: 'retry-source' }]; await render()
  expect(animate).toHaveBeenCalledTimes(1)
  expect(document.activeElement).toBe(outside)
  state.overlays = []; await render()
  state.overlays = [{ ...overlay, sourceId: 'retry-source' }]; await render()
  expect(animate).toHaveBeenCalledTimes(1)
  await render([log], 'other-session'); await render()
  expect(animate).toHaveBeenCalledTimes(1)
  const stream = { ...log, id: 'stream', textBlock: { ...log.textBlock!, blockId: 'stream', state: 'OPEN' as const } }
  state.overlays = []; await render([log, stream]); await render([log, { ...stream, content: 'stream delta' }])
  expect(animate).toHaveBeenCalledTimes(1)
  const sealed = { ...stream, textBlock: { ...stream.textBlock!, state: 'SEALED' as const } }
  state.overlays = [{ ...overlay, sourceId: 'stream-source', blockId: 'stream' }]; await render([log, sealed])
  expect(animate).toHaveBeenCalledTimes(2)
  await render([log, sealed]); expect(animate).toHaveBeenCalledTimes(2)
  outside.remove(); delete (Element.prototype as unknown as { animate?: unknown }).animate
})

it('consumes a new completion without animation when reduced motion is preferred', async () => {
  const animate = vi.fn(() => ({ cancel: vi.fn() }))
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate })
  const media = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  state.overlays = [{ ...overlay, state: 'RUNNING', translatedText: null }]; await render()
  state.overlays = [overlay]; await render()
  expect(animate).not.toHaveBeenCalled()
  media.mockRestore(); delete (Element.prototype as unknown as { animate?: unknown }).animate
})
