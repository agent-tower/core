import type { ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { translate } from '@/lib/i18n'
import { ErrorBoundary } from './ErrorBoundary'

/**
 * Outermost render-error backstop. It sits above every app provider
 * (`QueryClientProvider`, `AccessGate`, `I18nProvider`), so a render error in
 * the shell itself cannot unmount the whole document and leave a blank page.
 *
 * Why the fallback is built differently from the others: it must not depend on
 * anything the shell provides. It calls `translate()` - the module-level helper
 * `AccessGate` already uses, backed by the stored/browser locale - instead of
 * the `useI18n()` context, and it uses no router, query or auth state. That way
 * it still renders when one of those providers is the thing that broke.
 *
 * Coverage note: this catches render-phase errors of the shell subtree only.
 * Errors raised in event handlers, timers, promise rejections or observers
 * never reach an error boundary (see `ErrorBoundary`), and the module-level
 * bootstrap in `main.tsx` runs before `<App />` mounts, so it stays outside
 * every boundary. Re-rendering the same shell would just throw again, so the
 * only action offered is a reload; the crash itself is written to the error
 * log under `app-shell`.
 */
export function AppShellBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      source="app-shell"
      fallback={({ error }) => (
        <div
          role="alert"
          className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 py-12 text-center text-foreground"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-destructive/20 bg-destructive/10 text-destructive">
            <AlertTriangle size={22} />
          </div>
          <div className="space-y-1">
            <h1 className="text-base font-semibold">{translate('Something went wrong')}</h1>
            <p className="max-w-md text-sm text-muted-foreground">
              {translate('The interface could not be displayed. Reload the page to try again.')}
            </p>
          </div>
          <p
            className="max-w-xl truncate rounded-md border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground"
            title={error.message || error.name}
          >
            {error.message || error.name}
          </p>
          <p className="max-w-md text-[11px] text-muted-foreground/80">
            {translate('Only rendering errors are caught here. Errors from event handlers, async callbacks or observers are not.')}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3.5 py-1.5 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand/90"
          >
            <RotateCcw size={13} />
            {translate('Reload page')}
          </button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
