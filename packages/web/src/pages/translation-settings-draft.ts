import { compileTranslationPrompts, DEFAULT_TRANSLATION_SYSTEM_PROMPT, type TranslationPublicSettings, type TranslationSettingsDraft } from '@agent-tower/shared'

export function translationDraft(value: TranslationPublicSettings): TranslationSettingsDraft {
  const { enabled, apiBaseUrl, model, sendTargetLanguage, displayTargetLanguage, systemPrompt, promptTemplate, maxConcurrency } = value
  return { enabled, apiBaseUrl, model, sendTargetLanguage, displayTargetLanguage, systemPrompt, promptTemplate, maxConcurrency, apiKey: { action: 'keep' } }
}

export function validateTranslationDraft(draft: TranslationSettingsDraft, execution: boolean): string | null {
  if (!Number.isInteger(draft.maxConcurrency) || draft.maxConcurrency < 1 || draft.maxConcurrency > 16) return 'Concurrency must be an integer from 1 to 16.'
  if (draft.apiBaseUrl.trim() || execution) {
    try {
      const input = draft.apiBaseUrl.trim()
      const url = new URL(input)
      if (!/^https?:\/\//i.test(input) || !['http:', 'https:'].includes(url.protocol) || !url.host || url.username || url.password
        || input.includes('?') || input.includes('#') || /[\r\n\0]/.test(input) || /^https?:\/\/[^/]*@/i.test(input)) throw new Error()
    } catch { return 'Enter an HTTP(S) base URL without credentials, query or fragment.' }
  }
  if (!execution) return null
  if (!draft.model.trim() || !draft.sendTargetLanguage.trim() || !draft.displayTargetLanguage.trim() || /[\r\n\0]/.test(draft.model + draft.sendTargetLanguage + draft.displayTargetLanguage)) return 'Enter a model and both target languages.'
  if (draft.apiKey.action === 'clear' || (draft.apiKey.action === 'replace' && /[\r\n\0]/.test(draft.apiKey.value))) return 'Complete the translation configuration and credential choice.'
  if (!compileTranslationPrompts(draft.systemPrompt ?? DEFAULT_TRANSLATION_SYSTEM_PROMPT, draft.promptTemplate)) {
    return 'Use {{text}} only in the user message and {{target_language}} in either prompt. These are the only supported variables.'
  }
  return null
}
