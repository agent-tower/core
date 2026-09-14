import { AlertTriangle, RotateCcw } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface SectionErrorFallbackProps {
  error: Error
  onRetry: () => void
  title?: string
  description?: string
  className?: string
}

/**
 * Recoverable fallback for one region of a page (log view, panel, ...).
 *
 * It replaces only the subtree that `ErrorBoundary` caught, so the rest of the
 * page keeps working. That statement is scoped to the *caught* error: it says
 * nothing about errors React never routes to an error boundary (event
 * handlers, timers, promise rejections, observer or socket callbacks). The
 * footnote below tells the user exactly that.
 */
export function SectionErrorFallback({
  error,
  onRetry,
  title,
  description,
  className,
}: SectionErrorFallbackProps) {
  const { t } = useI18n()

  return (
    <div
      role="alert"
      className={cn(
        'flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-destructive/20 bg-destructive/10 text-destructive">
        <AlertTriangle size={18} />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {title ?? t('Something went wrong')}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {description ?? t('This section hit a rendering error and was replaced by this message.')}
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
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
      >
        <RotateCcw size={13} />
        {t('Retry')}
      </button>
    </div>
  )
}
