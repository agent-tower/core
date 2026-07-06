import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { AppLocale } from '@agent-tower/shared'
import { useAppSettings, useUpdateAppSettings } from '@/hooks/use-app-settings'
import { messages } from './messages'

type TranslationValues = Record<string, string | number | boolean | null | undefined>

interface I18nContextValue {
  locale: AppLocale
  setLocale: (locale: AppLocale) => void
  t: (source: string, values?: TranslationValues) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)
const LOCALE_STORAGE_KEY = 'agent-tower.locale'

function resolveLocale(locale?: string | null): AppLocale | null {
  if (!locale) return null
  if (locale === 'en') return 'en'
  if (locale === 'zh-CN') return 'zh-CN'
  return null
}

function readStoredLocale(): AppLocale | null {
  if (typeof window === 'undefined') return null
  try {
    return resolveLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY))
  } catch {
    return null
  }
}

function writeStoredLocale(locale: AppLocale) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Ignore storage failures; the server-side setting remains authoritative.
  }
}

function detectBrowserLocale(): AppLocale {
  if (typeof navigator === 'undefined') return 'zh-CN'
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

function getClientPreferredLocale(): AppLocale {
  return readStoredLocale() ?? detectBrowserLocale()
}

function interpolate(template: string, values?: TranslationValues) {
  if (!values) return template

  let result = template
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, String(value ?? ''))
  }
  return result
}

let currentLocale: AppLocale = getClientPreferredLocale()

export function translateForLocale(locale: AppLocale, source: string, values?: TranslationValues) {
  const template = messages[locale]?.[source] ?? source
  return interpolate(template, values)
}

export function translate(source: string, values?: TranslationValues) {
  return translateForLocale(currentLocale, source, values)
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const fallbackLocaleRef = useRef<AppLocale>(getClientPreferredLocale())
  const [locale, setLocaleState] = useState<AppLocale>(fallbackLocaleRef.current)
  const { data } = useAppSettings()
  const updateAppSettings = useUpdateAppSettings()
  const autoPersistedFallbackRef = useRef(false)

  const applyLocale = useCallback((nextLocale: AppLocale) => {
    currentLocale = nextLocale
    setLocaleState(nextLocale)
    document.documentElement.lang = nextLocale
    writeStoredLocale(nextLocale)
  }, [])

  useEffect(() => {
    const nextLocale = resolveLocale(data?.locale) ?? fallbackLocaleRef.current
    applyLocale(nextLocale)

    if (data && data.locale === null && !autoPersistedFallbackRef.current) {
      autoPersistedFallbackRef.current = true
      updateAppSettings.mutate({ locale: nextLocale })
    }
  }, [data, applyLocale, updateAppSettings])

  const setLocale = useCallback((nextLocale: AppLocale) => {
    const previousLocale = currentLocale
    applyLocale(nextLocale)
    updateAppSettings.mutate(
      { locale: nextLocale },
      {
        onError: () => {
          applyLocale(previousLocale)
          toast.error(translate('语言设置保存失败'))
        },
      },
    )
  }, [applyLocale, updateAppSettings])

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    t: (source, values) => translateForLocale(locale, source, values),
  }), [locale, setLocale])

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  const context = useContext(I18nContext)
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider')
  }
  return context
}
