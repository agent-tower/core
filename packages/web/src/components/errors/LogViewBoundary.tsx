import type { ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'
import { ErrorBoundary } from './ErrorBoundary'
import { SectionErrorFallback } from './SectionErrorFallback'

/**
 * Render-error backstop for a session/task log view.
 *
 * `LogStream` is the component that consumes conversation entries, so a
 * malformed entry can throw while it renders. This boundary contains *that*
 * error: only the log area is replaced, and the surrounding page (session
 * list, input box, workspace panels) is not unmounted by it.
 *
 * Scope, so the copy stays honest: `ErrorBoundary` only sees errors thrown
 * while rendering this subtree or in its lifecycle methods. Errors raised in
 * event handlers, timers, promise rejections, observers or socket callbacks
 * never reach it (they do not unmount the page either - they need their own
 * handling). Sibling components *outside* this subtree are not covered here
 * either; a render error there is answered by the page-level route fallback.
 */
export function LogViewBoundary({ children }: { children: ReactNode }) {
  const { t } = useI18n()

  return (
    <ErrorBoundary
      source="log-view"
      fallback={({ error, reset }) => (
        <SectionErrorFallback
          title={t('Failed to display logs')}
          description={t('The log view hit a rendering error. Retry renders the same data again, so it will fail again while the bad data is still there.')}
          error={error}
          onRetry={reset}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
