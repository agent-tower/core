import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { NavigateOptions, To } from 'react-router-dom'
import { useLocation, useNavigate } from 'react-router-dom'

const DESKTOP_TITLEBAR_STORAGE_KEY = 'agent-tower:desktop-titlebar'
const DESKTOP_SEARCH_PARAMS = {
  desktop: '1',
  desktopTitlebar: 'integrated',
} as const

type DesktopTitlebarMode = 'integrated' | 'none'

interface DesktopTitlebarContextValue {
  usesIntegratedTitlebar: boolean
  preserveDesktopSearch: (to: To) => To
}

type DesktopNavigate = {
  (to: To, options?: NavigateOptions): void | Promise<void>
  (delta: number): void | Promise<void>
}

const DesktopTitlebarContext = createContext<DesktopTitlebarContextValue | null>(null)
const DEFAULT_DESKTOP_TITLEBAR_CONTEXT: DesktopTitlebarContextValue = {
  usesIntegratedTitlebar: false,
  preserveDesktopSearch: (to) => to,
}

function isIntegratedTitlebarSearch(search: string) {
  const params = new URLSearchParams(search)
  return (
    params.get('desktop') === DESKTOP_SEARCH_PARAMS.desktop
    && params.get('desktopTitlebar') === DESKTOP_SEARCH_PARAMS.desktopTitlebar
  )
}

function readStoredTitlebarMode(): DesktopTitlebarMode {
  if (typeof window === 'undefined') return 'none'
  try {
    return window.sessionStorage.getItem(DESKTOP_TITLEBAR_STORAGE_KEY) === DESKTOP_SEARCH_PARAMS.desktopTitlebar
      ? 'integrated'
      : 'none'
  } catch {
    return 'none'
  }
}

function storeTitlebarMode(mode: DesktopTitlebarMode) {
  if (typeof window === 'undefined') return
  try {
    if (mode === 'integrated') {
      window.sessionStorage.setItem(DESKTOP_TITLEBAR_STORAGE_KEY, DESKTOP_SEARCH_PARAMS.desktopTitlebar)
    } else {
      window.sessionStorage.removeItem(DESKTOP_TITLEBAR_STORAGE_KEY)
    }
  } catch {
    // sessionStorage can be unavailable in restricted browser contexts.
  }
}

function getInitialTitlebarMode(search: string): DesktopTitlebarMode {
  if (isIntegratedTitlebarSearch(search)) {
    storeTitlebarMode('integrated')
    return 'integrated'
  }
  return readStoredTitlebarMode()
}

function mergeDesktopSearch(search: string) {
  const params = new URLSearchParams(search)
  params.set('desktop', DESKTOP_SEARCH_PARAMS.desktop)
  params.set('desktopTitlebar', DESKTOP_SEARCH_PARAMS.desktopTitlebar)
  const merged = params.toString()
  return merged ? `?${merged}` : ''
}

function withDesktopSearch(to: To): To {
  if (typeof to === 'string') {
    const hashIndex = to.indexOf('#')
    const beforeHash = hashIndex >= 0 ? to.slice(0, hashIndex) : to
    const hash = hashIndex >= 0 ? to.slice(hashIndex) : ''
    const searchIndex = beforeHash.indexOf('?')
    const pathname = searchIndex >= 0 ? beforeHash.slice(0, searchIndex) : beforeHash
    const search = searchIndex >= 0 ? beforeHash.slice(searchIndex) : ''
    return `${pathname}${mergeDesktopSearch(search)}${hash}`
  }

  return {
    ...to,
    search: mergeDesktopSearch(to.search ?? ''),
  }
}

export function DesktopTitlebarProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const mode = useMemo(() => getInitialTitlebarMode(location.search), [location.search])
  const usesIntegratedTitlebar = mode === 'integrated'

  const value = useMemo<DesktopTitlebarContextValue>(() => ({
    usesIntegratedTitlebar,
    preserveDesktopSearch: (to) => (usesIntegratedTitlebar ? withDesktopSearch(to) : to),
  }), [usesIntegratedTitlebar])

  return (
    <DesktopTitlebarContext.Provider value={value}>
      {children}
    </DesktopTitlebarContext.Provider>
  )
}

export function useDesktopTitlebar() {
  const value = useContext(DesktopTitlebarContext)
  return value ?? DEFAULT_DESKTOP_TITLEBAR_CONTEXT
}

export function useDesktopNavigate() {
  const navigate = useNavigate()
  const { preserveDesktopSearch } = useDesktopTitlebar()

  return useMemo(() => {
    const desktopNavigate: DesktopNavigate = ((to: To | number, options?: NavigateOptions) => {
      if (typeof to === 'number') {
        return navigate(to)
      }
      return navigate(preserveDesktopSearch(to), options)
    }) as DesktopNavigate

    return desktopNavigate
  }, [navigate, preserveDesktopSearch])
}
