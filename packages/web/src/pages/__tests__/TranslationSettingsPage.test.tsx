// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TRANSLATION_PROMPT_TEMPLATE, type TranslationPublicSettings } from '@agent-tower/shared'
import { apiClient, ApiError } from '@/lib/api-client'
import { TranslationSettingsPage } from '../TranslationSettingsPage'
import { queryKeys } from '@/hooks/query-keys'
import { validateTranslationDraft, translationDraft } from '../translation-settings-draft'

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (value: string) => value }) }))
vi.mock('@/lib/api-client', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>()
  return { ...actual, apiClient: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }
})
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings: TranslationPublicSettings = {
  id: 'singleton', revision: 3, enableEpoch: 0, credentialRevision: 1, keyConfigured: false,
  enabled: false, apiBaseUrl: 'https://translate.example/v1', model: 'small-model',
  sendTargetLanguage: 'English', displayTargetLanguage: 'English',
  promptTemplate: DEFAULT_TRANSLATION_PROMPT_TEMPLATE, maxConcurrency: 4,
}
let client: QueryClient
let root: Root
let container: HTMLDivElement
const get = vi.mocked(apiClient.get)
const put = vi.mocked(apiClient.put)
const post = vi.mocked(apiClient.post)

async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
async function mount() {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<QueryClientProvider client={client}><TranslationSettingsPage /></QueryClientProvider>))
  for (let attempt = 0; attempt < 50; attempt++) {
    await flush()
    if (container.querySelector('#translation-model')) break
  }
}
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent === text)
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
function input(id: string) { return container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)! }
function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
function mode(value: string) { change(container.querySelector('#translation-key-intent')!, value) }
function secretInput() { return container.querySelector<HTMLInputElement>('input[type="password"]')! }
function cacheText() { return JSON.stringify({ queries: client.getQueryCache().getAll().map(item => item.state), mutations: client.getMutationCache().getAll() }) }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear(); sessionStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  get.mockResolvedValue(settings)
  put.mockImplementation(async (_path, body) => ({ ...settings, ...(body as object), revision: 4 }) as never)
})
afterEach(() => { act(() => root?.unmount()); container?.remove(); client.clear() })

describe('Translation settings draft boundary', () => {
  it('searches the standard catalog and saves both languages independently while preserving a custom value', async () => {
    await mount()
    expect(container.querySelector('#sendTargetLanguage')?.textContent).toContain('English')
    act(() => (container.querySelector('#sendTargetLanguage') as HTMLButtonElement).click()); await flush()
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search languages"]')!
    change(search, 'pt-BR'); await flush()
    const portuguese = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.textContent?.includes('pt-BR'))!
    expect(portuguese).toBeDefined()
    act(() => portuguese.click()); await flush()
    expect(container.querySelector('#displayTargetLanguage')?.textContent).toContain('English')
    act(() => button('保存').click()); await flush()
    expect(put.mock.calls[0][1]).toMatchObject({ sendTargetLanguage: 'pt-BR', displayTargetLanguage: 'English' })
    act(() => (container.querySelector('#displayTargetLanguage') as HTMLButtonElement).click()); await flush()
    change(document.querySelector<HTMLInputElement>('[aria-label="Search languages"]')!, 'zh-Hant-TW'); await flush()
    const chinese = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.textContent?.includes('zh-Hant-TW'))!
    expect(chinese).toBeDefined(); act(() => chinese.click()); await flush()
    act(() => button('保存').click()); await flush()
    expect(put.mock.calls[1][1]).toMatchObject({ sendTargetLanguage: 'pt-BR', displayTargetLanguage: 'zh-Hant-TW' })
  })

  it('caches only public settings and sends all four explicit credential intents without a mutation cache', async () => {
    get.mockResolvedValue({ ...settings, apiKey: 'server-must-never-return-this' })
    await mount()
    expect(cacheText()).not.toContain('server-must-never-return-this')
    expect(secretInput()).toBeNull()
    act(() => button('保存').click()); await flush()
    expect(put.mock.calls[0][1]).toMatchObject({ apiKey: { action: 'keep' }, expectedRevision: 3, sendTargetLanguage: 'English', displayTargetLanguage: 'English' })
    mode('replace'); change(secretInput(), 'secret-sentinel')
    act(() => button('保存').click()); await flush()
    expect(put.mock.calls[1][1]).toMatchObject({ apiKey: { action: 'replace', value: 'secret-sentinel' }, expectedRevision: 4 })
    expect(secretInput()).toBeNull()
    mode('clear'); act(() => button('保存').click()); await flush()
    expect(put.mock.calls[2][1]).toMatchObject({ apiKey: { action: 'clear' } })
    mode('anonymous'); act(() => button('保存').click()); await flush()
    expect(put.mock.calls[3][1]).toMatchObject({ apiKey: { action: 'replace', value: '' } })
    expect(cacheText()).not.toContain('secret-sentinel')
    expect(localStorage.length + sessionStorage.length).toBe(0)
    expect(client.getMutationCache().getAll()).toHaveLength(0)
  })

  it('preserves local fields, revision and transient key after a 409, with explicit discard to reload', async () => {
    put.mockRejectedValue(new ApiError(409, 'unsafe provider body', { code: 'TRANSLATION_SETTINGS_CONFLICT' }))
    await mount()
    change(input('translation-model'), 'my-unsaved-model')
    mode('replace'); change(secretInput(), 'conflict-secret')
    act(() => button('保存').click()); await flush()
    expect(input('translation-model').value).toBe('my-unsaved-model')
    expect(secretInput().value).toBe('conflict-secret')
    expect(button('保存').disabled).toBe(true)
    expect(get).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('unsafe provider body')
    expect(cacheText()).not.toContain('conflict-secret')
    get.mockResolvedValue({ ...settings, revision: 8, model: 'other-tab' })
    act(() => button('Discard draft and reload saved settings').click()); await flush()
    expect(input('translation-model').value).toBe('other-tab')
    expect(secretInput()).toBeNull()
    expect(put).toHaveBeenCalledTimes(1)
  })

  it('tests unsaved SEND and DISPLAY drafts without saving or delivering; ignores late results after edits', async () => {
    let finish!: (value: { resultText: string }) => void
    post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }) as never)
    await mount()
    mode('anonymous')
    change(input('translation-model'), 'unsaved-model')
    const sample = container.querySelector<HTMLTextAreaElement>('[aria-label="Sample text"]')!
    change(sample, 'test sample')
    act(() => button('Test translation').click())
    expect(post.mock.calls[0].slice(0, 2)).toEqual(['/translation-settings/test', {
      draft: { ...translationDraft(settings), model: 'unsaved-model', apiKey: { action: 'replace', value: '' } }, text: 'test sample', direction: 'SEND',
    }])
    change(input('translation-model'), 'new-model')
    await act(async () => finish({ resultText: 'late-result' })); await flush()
    expect(container.textContent).not.toContain('late-result')
    change(container.querySelector('#translation-test-direction')!, 'DISPLAY')
    post.mockResolvedValueOnce({ resultText: 'display-result' })
    act(() => button('Test translation').click()); await flush()
    expect(post.mock.calls[1][1]).toMatchObject({ direction: 'DISPLAY', draft: { model: 'new-model' } })
    expect(container.textContent).toContain('display-result')
    expect(put).not.toHaveBeenCalled()
    expect(post.mock.calls.every(call => call[0] === '/translation-settings/test')).toBe(true)
    expect(client.getQueryData<TranslationPublicSettings>(queryKeys.translationSettings.detail)?.enabled).toBe(false)
  })

  it('does not retain a tested key or request variables in caches, storage or a remounted form', async () => {
    post.mockResolvedValue({ resultText: 'safe result' })
    await mount(); mode('replace'); change(secretInput(), 'test-secret-sentinel')
    change(container.querySelector<HTMLTextAreaElement>('[aria-label="Sample text"]')!, 'sample')
    act(() => button('Test translation').click()); await flush()
    expect(post.mock.calls[0][1]).toMatchObject({ draft: { apiKey: { action: 'replace', value: 'test-secret-sentinel' } } })
    expect(cacheText()).not.toContain('test-secret-sentinel')
    expect(localStorage.length + sessionStorage.length).toBe(0)
    act(() => root.unmount()); container.remove()
    await mount()
    expect(secretInput()).toBeNull()
    expect(container.innerHTML).not.toContain('test-secret-sentinel')
  })

  it.each(['sample', 'direction', 'key'])('ignores a late draft test after changing %s', async field => {
    let finish!: (value: { resultText: string }) => void
    post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }) as never)
    await mount()
    mode('anonymous')
    change(container.querySelector<HTMLTextAreaElement>('[aria-label="Sample text"]')!, 'first sample')
    act(() => button('Test translation').click())
    if (field === 'sample') change(container.querySelector<HTMLTextAreaElement>('[aria-label="Sample text"]')!, 'next sample')
    if (field === 'direction') change(container.querySelector('#translation-test-direction')!, 'DISPLAY')
    if (field === 'key') mode('keep')
    expect(post.mock.calls[0][2]?.signal?.aborted).toBe(true)
    await act(async () => finish({ resultText: 'stale test response' })); await flush()
    expect(container.textContent).not.toContain('stale test response')
    expect(put).not.toHaveBeenCalled()
  })

  it('allows incomplete disabled drafts but checks execution templates and credentials before testing or enabling', async () => {
    await mount()
    change(input('translation-template'), '{{unknown}}')
    change(input('translation-model'), '')
    act(() => button('保存').click()); await flush()
    expect(put).toHaveBeenCalledTimes(1)
    act(() => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    act(() => button('保存').click()); await flush()
    expect(put).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Enter a model and both target languages.')
    change(input('translation-model'), 'model')
    act(() => button('保存').click()); await flush()
    expect(container.textContent).toContain('The template must contain only')
    expect(put).toHaveBeenCalledTimes(1)
  })
})

describe('translation execution validation', () => {
  it('accepts identical languages, spaced variables, and a stored anonymous keep; rejects unsafe URL/template', () => {
    const draft = translationDraft(settings)
    expect(validateTranslationDraft({ ...draft, promptTemplate: '{{ target_language }} {{text}}' }, true)).toBeNull()
    for (const url of ['https://user:secret@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/#fragment', 'file:///tmp', 'https:example.com', 'https://example.com/?', 'https://example.com/#', 'https://@example.com']) {
      expect(validateTranslationDraft({ ...draft, apiBaseUrl: url }, true)).not.toBeNull()
    }
    for (const template of ['{{text}}', '{{target_language}} {{unknown}} {{text}}', '{{text}} {{target_language}} {{broken', '{{{text}} {{target_language}}']) {
      expect(validateTranslationDraft({ ...draft, promptTemplate: template }, true)).not.toBeNull()
    }
    expect(validateTranslationDraft({ ...draft, apiKey: { action: 'clear' } }, true)).not.toBeNull()
  })
})
