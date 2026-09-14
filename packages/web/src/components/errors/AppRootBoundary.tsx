import type { ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { ErrorBoundary } from './ErrorBoundary'

/**
 * Last-resort backstop for render errors raised outside the router
 * (`GlobalRealtimeSync`, router internals, ...). Route-level failures are
 * already handled by `RouteErrorPage` inside the router, so this only renders
 * when nothing else could.
 *
 * It sits *inside* `I18nProvider` (its fallback renders translated copy) and
 * therefore does not cover the providers themselves: `AccessGate`,
 * `I18nProvider`, `QueryClientProvider` and the `Toaster` sibling are outside
 * this boundary. The provider shell is covered by `AppShellBoundary`, and the
 * toaster by its own quiet boundary in `App.tsx`.
 */
export function AppRootBoundary({ children }: { children: ReactNode }) {
  const { t } = useI18n()

  return (
    <ErrorBoundary
      source="app-root"
      fallback={({ error }) => (
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
              {t('The interface hit a rendering error. Reload the page to continue.')}
            </p>
          </div>
          <p
            className="max-w-xl truncate rounded-md border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground"
            title={error.message || error.name}
          >
            {error.message || error.name}
          </p>
          <p className="max-w-md text-[11px] text-muted-foreground/80">
            {t('Only rendering errors are caught here. Errors from event handlers, async callbacks or observers are not.')}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3.5 py-1.5 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand/90"
          >
            <RotateCcw size={13} />
            {t('Reload page')}
          </button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
