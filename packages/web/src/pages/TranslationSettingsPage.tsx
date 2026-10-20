import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { TranslationDirection, TranslationDraftTestResult, TranslationPublicSettings, TranslationSettingsDraft } from '@agent-tower/shared'
import { apiClient, ApiError } from '@/lib/api-client'
import { useI18n } from '@/lib/i18n'
import { queryKeys } from '@/hooks/query-keys'
import { publicTranslationSettings, translationErrorMessage, useTranslationSettings } from '@/hooks/use-translation-settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/design-system'
import { SettingsField, SettingsFormSkeleton, SettingsPageContainer, SettingsPageHeader } from '@/components/settings/SettingsSection'
import { translationDraft, validateTranslationDraft } from './translation-settings-draft'
import { LanguageSelector } from '@/components/agent/LanguageSelector'

export function TranslationSettingsPage() {
  const { t } = useI18n()
  const query = useTranslationSettings()
  const [reset, setReset] = useState(0)
  return <SettingsPageContainer>
    {!query.data ? query.isError
      ? <div role="alert">{t('Could not load translation settings.')} <Button onClick={() => void query.refetch()}>{t('重试')}</Button></div>
      : <SettingsFormSkeleton />
      : <TranslationSettingsForm key={reset} initial={query.data} reload={async () => {
        const result = await query.refetch()
        if (!result.isSuccess) throw new Error()
        setReset(value => value + 1)
      }} />}
  </SettingsPageContainer>
}

function TranslationSettingsForm({ initial, reload }: { initial: TranslationPublicSettings; reload: () => Promise<void> }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const [draft, setDraft] = useState(() => translationDraft(initial))
  const [revision, setRevision] = useState(initial.revision)
  const [keyConfigured, setKeyConfigured] = useState(initial.keyConfigured)
  const [keyMode, setKeyMode] = useState('keep')
  const [keyValue, setKeyValue] = useState('')
  const [text, setText] = useState('')
  const [direction, setDirection] = useState<TranslationDirection>('SEND')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const sequence = useRef(0)
  const testController = useRef<AbortController | null>(null)
  const saveController = useRef<AbortController | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; sequence.current++; testController.current?.abort(); saveController.current?.abort() }
  }, [])
  const invalidateTest = () => {
    sequence.current++
    testController.current?.abort()
    setTesting(false)
    setResult(null)
    setError(null)
    setNotice(null)
  }
  const update = <K extends keyof TranslationSettingsDraft>(key: K, value: TranslationSettingsDraft[K]) => {
    invalidateTest()
    setDraft(current => ({ ...current, [key]: value }))
  }
  const requestDraft = (): TranslationSettingsDraft => ({ ...draft, apiKey: keyMode === 'anonymous'
    ? { action: 'replace', value: '' }
    : keyMode === 'replace' ? { action: 'replace', value: keyValue }
      : keyMode === 'clear' ? { action: 'clear' } : { action: 'keep' } })
  const validate = (input: TranslationSettingsDraft, execution: boolean) => {
    if (keyMode === 'replace' && !keyValue) return 'Enter a new API key, or explicitly choose a service without credentials.'
    return validateTranslationDraft(input, execution)
  }
  const save = async () => {
    invalidateTest()
    const input = requestDraft()
    const validation = validate(input, input.enabled)
    if (validation) { setError(validation); return }
    const controller = new AbortController()
    saveController.current = controller
    setSaving(true)
    try {
      const saved = publicTranslationSettings(await apiClient.put<TranslationPublicSettings>('/translation-settings', { ...input, expectedRevision: revision }, { signal: controller.signal }))
      if (!alive.current) return
      client.setQueryData(queryKeys.translationSettings.detail, saved)
      setDraft(translationDraft(saved))
      setRevision(saved.revision)
      setKeyConfigured(saved.keyConfigured)
      setKeyValue('')
      setKeyMode('keep')
      setConflict(false)
      setNotice('Translation settings saved.')
    } catch (cause) {
      if (!alive.current) return
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(true)
        setError('Settings changed in another tab. Your draft is preserved. Reload saved settings to discard this draft.')
      } else setError(translationErrorMessage(cause))
    } finally { if (alive.current) setSaving(false) }
  }
  const test = async () => {
    invalidateTest()
    const input = requestDraft()
    const validation = validate(input, true)
    if (validation || !text.trim()) { setError(validation ?? 'Enter sample text to test.'); return }
    const token = sequence.current
    const controller = new AbortController()
    testController.current = controller
    setTesting(true)
    try {
      const response = await apiClient.post<TranslationDraftTestResult>('/translation-settings/test', { draft: input, text, direction }, { signal: controller.signal })
      if (alive.current && token === sequence.current) setResult(response.resultText)
    } catch (cause) {
      if (alive.current && token === sequence.current) setError(translationErrorMessage(cause))
    } finally { if (alive.current && token === sequence.current) setTesting(false) }
  }
  return <>
    <SettingsPageHeader title={t('语言转换')} description={t('Translate outgoing messages and Agent replies. Saving applies the global switch.')} />
    <fieldset disabled={saving} className="min-w-0 space-y-5">
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border p-4">
        <div><label htmlFor="translation-enabled" className="text-sm font-medium">{t('Enable translation')}</label><p className="mt-1 text-xs text-muted-foreground">{t('When disabled, successful historical translations remain available. Pending messages are not sent automatically.')}</p></div>
        <Switch id="translation-enabled" aria-label={t('Enable translation')} checked={draft.enabled} onCheckedChange={value => update('enabled', value)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {(['sendTargetLanguage', 'displayTargetLanguage'] as const).map((key, i) => <SettingsField key={key} htmlFor={key} label={t(i === 0 ? 'Send target language' : 'Reply display language')}>
          <LanguageSelector id={key} value={draft[key]} onChange={value => update(key, value)} />
        </SettingsField>)}
      </div>
      <p className="text-xs text-muted-foreground">{t('Language directory: IANA language subtags and Unicode CLDR 48.1 regional variants. Saved custom values are preserved.')}</p>
      <SettingsField htmlFor="translation-base-url" label={t('API base URL')} description={t('OpenAI compatible base URL. The server appends /chat/completions.')}>
        <Input id="translation-base-url" placeholder="https://api.openai.com/v1" maxLength={2048} value={draft.apiBaseUrl} onChange={event => update('apiBaseUrl', event.target.value)} />
      </SettingsField>
      <SettingsField htmlFor="translation-model" label={t('Model')}>
        <Input id="translation-model" maxLength={256} value={draft.model} onChange={event => update('model', event.target.value)} />
      </SettingsField>
      <SettingsField htmlFor="translation-key-intent" label={t('API key (write only)')} description={t(keyConfigured ? 'A stored credential is configured. Its value is never displayed.' : 'No stored credential is indicated. A service without credentials may already be configured.')}>
        <select id="translation-key-intent" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={keyMode} onChange={event => { invalidateTest(); setKeyValue(''); setKeyMode(event.target.value) }}>
          <option value="keep">{t('Keep saved credential choice')}</option>
          <option value="replace">{t('Replace API key')}</option>
          <option value="clear">{t('Clear credential configuration')}</option>
          <option value="anonymous">{t('Service without credentials')}</option>
        </select>
        {keyMode === 'replace' && <Input className="mt-2" type="password" aria-label={t('New API key')} autoComplete="off" maxLength={16384} value={keyValue} onChange={event => { invalidateTest(); setKeyValue(event.target.value) }} />}
        {keyMode === 'clear' && <p className="mt-2 text-xs text-muted-foreground">{t('Clearing prevents enabling and testing until a credential choice is configured.')}</p>}
      </SettingsField>
      <SettingsField htmlFor="translation-template" label={t('Shared prompt template')} description={t('Both directions use this template. Include {{target_language}} and {{text}}; unknown variables are invalid.')}>
        <Textarea id="translation-template" className="min-h-32 font-mono text-xs" maxLength={32768} value={draft.promptTemplate} onChange={event => update('promptTemplate', event.target.value)} />
      </SettingsField>
      <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm font-medium">{t('高级配置')}</summary>
        <SettingsField className="mt-4" htmlFor="translation-concurrency" label={t('Maximum translation concurrency (1–16)')}><Input id="translation-concurrency" type="number" min={1} max={16} step={1} value={draft.maxConcurrency} onChange={event => update('maxConcurrency', Number(event.target.value))} /></SettingsField>
      </details>
      <section className="space-y-3 rounded-xl border border-border bg-muted/20 p-4" aria-label={t('Test draft translation')}>
        <h3 className="text-sm font-medium">{t('Test draft translation')}</h3>
        <p className="text-xs text-muted-foreground">{t('Sample text is sent to the configured translation service. Testing does not save settings or send messages to an Agent.')}</p>
        <SettingsField htmlFor="translation-test-direction" label={t('Test direction')}><select id="translation-test-direction" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={direction} onChange={event => { invalidateTest(); setDirection(event.target.value as TranslationDirection) }}>
          <option value="SEND">{t('Send target language')}</option><option value="DISPLAY">{t('Reply display language')}</option>
        </select></SettingsField>
        <Textarea aria-label={t('Sample text')} maxLength={256 * 1024} className="min-h-24" value={text} onChange={event => { invalidateTest(); setText(event.target.value) }} />
        <Button type="button" variant="outline" disabled={testing} onClick={() => void test()}>{t(testing ? 'Testing…' : 'Test translation')}</Button>
        {result !== null && <div role="status" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 text-sm">{result}</div>}
      </section>
    </fieldset>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{t(error)}</p>}
    {notice && <p role="status" className="mt-4 text-sm">{t(notice)}</p>}
    <div className="sticky bottom-0 mt-5 flex flex-wrap justify-end gap-2 border-t border-border bg-background/95 py-3">
      {conflict && <Button variant="outline" disabled={saving} onClick={() => { invalidateTest(); void reload().catch(() => setError('Could not load translation settings.')) }}>{t('Discard draft and reload saved settings')}</Button>}
      <Button disabled={saving || conflict} onClick={() => void save()}>{t(saving ? '保存中...' : '保存')}</Button>
    </div>
  </>
}
