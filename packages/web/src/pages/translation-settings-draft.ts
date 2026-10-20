import type { TranslationPublicSettings, TranslationSettingsDraft } from '@agent-tower/shared'

export function translationDraft(value: TranslationPublicSettings): TranslationSettingsDraft {
  const { enabled, apiBaseUrl, model, sendTargetLanguage, displayTargetLanguage, promptTemplate, maxConcurrency } = value
  return { enabled, apiBaseUrl, model, sendTargetLanguage, displayTargetLanguage, promptTemplate, maxConcurrency, apiKey: { action: 'keep' } }
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
  const variables = new Set<string>()
  let invalid = false
  let cursor = 0
  for (const match of draft.promptTemplate.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const literal = draft.promptTemplate.slice(cursor, match.index)
    if (literal.includes('{{') || literal.includes('}}')) invalid = true
    const name = match[1].trim()
    if (name !== 'text' && name !== 'target_language') invalid = true
    variables.add(name)
    cursor = match.index + match[0].length
  }
  const rest = draft.promptTemplate.slice(cursor)
  if (invalid || rest.includes('{{') || rest.includes('}}') || !variables.has('text') || !variables.has('target_language')) return 'The template must contain only {{target_language}} and {{text}}, including both variables.'
  return null
}
