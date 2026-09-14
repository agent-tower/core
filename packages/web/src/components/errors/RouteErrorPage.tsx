import { useEffect, useRef } from 'react'
import { useNavigate, useRouteError } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, RotateCcw } from 'lucide-react'
import { logClientError } from '@/lib/error-log'
import { useI18n } from '@/lib/i18n'

function describeRouteError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const { status, statusText, message } = error as { status?: unknown; statusText?: unknown; message?: unknown }
    if (typeof message === 'string' && message) return message
    if (typeof status === 'number') {
      return typeof statusText === 'string' && statusText ? `${status} ${statusText}` : String(status)
    }
  }
  if (error === undefined || error === null) return 'Unknown route error'
  return String(error)
}

/**
 * Route-level backstop (`errorElement`).
 *
 * Rendered by React Router when a route element (or `RootLayout` itself) throws
 * while rendering, so the user gets a page they can leave instead of a blank
 * screen. Two call sites share this component: the pathless grouping route in
 * `routes/index.tsx` renders it inside `RootLayout`'s `<Outlet />` (app chrome
 * stays), and the root route renders it when `RootLayout` itself fails (chrome
 * is replaced too). Router data errors (e.g. an unmatched URL) also land here.
 *
 * It renders translated copy, so it must stay inside `I18nProvider`
 * (`AppRootBoundary`/`AppShellBoundary` sit above it).
 *
 * Scope: only errors React Router routes to an `errorElement` are shown here.
 * Errors thrown in event handlers, async callbacks or observers are not caught
 * and are not displayed by this page (see the footnote below).
 *
 * The error is written to the error log exactly once per error object.
 */
export function RouteErrorPage() {
  const error = useRouteError()
  const navigate = useNavigate()
  const { t } = useI18n()
  const reportedRef = useRef<unknown>(undefined)

  useEffect(() => {
    if (reportedRef.current === error) return
    reportedRef.current = error
    logClientError('router.errorElement', error, {
      metadata: { path: typeof window === 'undefined' ? null : window.location.pathname },
    })
  }, [error])

  const message = describeRouteError(error)

  return (
    <div
      role="alert"
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 py-12 text-center text-foreground"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-destructive/20 bg-destructive/10 text-destructive">
        <AlertTriangle size={22} />
      </div>
      <div className="space-y-1">
        <h1 className="text-base font-semibold">{t('Something went wrong')}</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {t('This page could not be displayed. Go back to the task board and try again.')}
        </p>
      </div>
      <p
        className="max-w-xl truncate rounded-md border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground"
        title={message}
      >
        {message}
      </p>
      <p className="max-w-md text-[11px] text-muted-foreground/80">
        {t('Only rendering errors are caught here. Errors from event handlers, async callbacks or observers are not.')}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3.5 py-1.5 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand/90"
        >
          <ArrowLeft size={13} />
          {t('Back to home')}
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <RotateCcw size={13} />
          {t('Retry')}
        </button>
      </div>
    </div>
  )
}
