import { useQuery } from '@tanstack/react-query'
import type { TranslationPublicSettings } from '@agent-tower/shared'
import { apiClient, ApiError } from '@/lib/api-client'
import { queryKeys } from './query-keys'

// Only this allowlist may enter Query cache. Secret writes use plain requests,
// never useMutation (whose variables live in MutationCache).
export function publicTranslationSettings(value: TranslationPublicSettings): TranslationPublicSettings {
  const { id, revision, enableEpoch, credentialRevision, keyConfigured, enabled, apiBaseUrl, model,
    sendTargetLanguage, displayTargetLanguage, promptTemplate, maxConcurrency } = value
  return { id, revision, enableEpoch, credentialRevision, keyConfigured, enabled, apiBaseUrl, model,
    sendTargetLanguage, displayTargetLanguage, promptTemplate, maxConcurrency }
}

export function useTranslationSettings() {
  return useQuery({
    queryKey: queryKeys.translationSettings.detail,
    queryFn: async ({ signal }) => publicTranslationSettings(await apiClient.get<TranslationPublicSettings>('/translation-settings', { signal })),
  })
}

const safeErrors: Record<string, string> = {
  AUTH_FAILED: 'Translation credential was rejected. Check the API key.',
  MODEL_CONFIG_ERROR: 'Check the translation base URL and model.',
  INVALID_CONFIG: 'Complete the translation configuration and credential choice.',
  INVALID_TEMPLATE: 'The template must contain only {{target_language}} and {{text}}, including both variables.',
  VALIDATION_ERROR: 'Check the translation fields and credential choice.',
  TIMEOUT: 'The translation request timed out. Try again.',
  NETWORK_ERROR: 'Could not connect to the translation service.',
  RATE_LIMITED: 'The translation service is busy. Try again later.',
  QUEUE_FULL: 'The translation queue is full. Try again later.',
  TRANSLATION_CLOSED: 'Translation testing is temporarily unavailable.',
  CANCELLED: 'The translation request was cancelled.',
  PAYLOAD_TOO_LARGE: 'The translation text is too large.',
  PROTECTION_FAILED: 'The translation changed protected content. The original is preserved.',
  EMPTY_RESPONSE: 'The translation service returned no usable text.',
  INVALID_RESPONSE: 'The translation service returned no usable text.',
  TRUNCATED_RESPONSE: 'The translation service returned incomplete text.',
  RESPONSE_TOO_LARGE: 'The translation response is too large.',
  UPSTREAM_ERROR: 'The translation service returned an error. Try again later.',
  INTERNAL_ERROR: 'An internal translation error occurred. Try again.',
  RETRY_BUDGET_EXHAUSTED: 'Translation retry limit reached. Try again manually.',
  CONFIG_CIRCUIT_OPEN: 'Translation is paused after a configuration error. Check the API key, base URL and model.',
  DISABLED: 'Translation is disabled. Enable it to retry.',
  INTERRUPTED: 'Translation was interrupted. Try again.',
  LEASE_EXPIRED: 'The translation attempt expired. Try again.',
  SOURCE_CHANGED: 'The original text changed. Retry the current text.',
  SOURCE_DELETED: 'The original message is no longer available.',
  SOURCE_OR_LEASE_REVOKED: 'The original message or translation attempt is no longer valid. Try again.',
}

export function translationErrorMessage(error: unknown): string {
  const code = typeof error === 'string' ? error : error instanceof ApiError ? error.details.code : undefined
  return typeof code === 'string' && Object.hasOwn(safeErrors, code) ? safeErrors[code] : 'Translation request failed. Check the service and try again.'
}
