import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, Circle, Loader2, XCircle } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'

export type TaskStartProgressState = {
  status: 'creating-workspace' | 'creating-session' | 'starting-session' | 'failed'
  error?: string
}

interface TaskStartProgressProps {
  state: TaskStartProgressState
  onRetry?: () => void
  /** Optional live setup command detail supplied by the workspace hook. */
  details?: string
  /** Use the tighter spacing used by the mobile task detail. */
  compact?: boolean
}

const STEP_STATUSES = ['creating-workspace', 'creating-session', 'starting-session'] as const

/**
 * A quiet, step based progress card shown while a task's workspace and agent
 * session are being prepared. Keeping this outside TaskDetail lets desktop
 * and mobile use the same visual language and state semantics.
 */
export function TaskStartProgress({ state, onRetry, details, compact = false }: TaskStartProgressProps) {
  const { t } = useI18n()
  const [showDetails, setShowDetails] = useState(false)
  const isFailed = state.status === 'failed'
  const currentIndex = STEP_STATUSES.indexOf(state.status as typeof STEP_STATUSES[number])
  const steps = [
    t('Preparing workspace'),
    t('Creating session'),
    t('Starting agent'),
  ]
  // The active step is already listed below. Keep the card header as a stable
  // task-level status so the first and last rows do not repeat the same label.
  const title = isFailed ? t('Agent start failed') : t('Starting task')

  return (
    <div
      className={`${compact ? 'mb-4' : 'mb-6'} w-full max-w-2xl rounded-xl border ${isFailed ? 'border-destructive/30 bg-destructive/[0.03]' : 'border-border/70 bg-background'} px-4 py-3 text-left shadow-sm`}
      role={isFailed ? 'alert' : 'status'}
      aria-live={isFailed ? 'assertive' : 'polite'}
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground/90">
        {isFailed ? <XCircle className="h-4 w-4 shrink-0 text-destructive" /> : <Loader2 className="h-4 w-4 shrink-0 animate-spin text-info motion-reduce:animate-none" />}
        <span>{title}</span>
      </div>
      {isFailed && state.error ? (
        <p className="mb-2 break-words text-xs text-destructive/80">{state.error}</p>
      ) : null}

      <div className="space-y-2">
        {steps.map((label, index) => {
          const completed = !isFailed && index < currentIndex
          const active = !isFailed && index === currentIndex
          // The API only reports a terminal failure, without the phase that
          // failed. Keep individual rows neutral and surface the error in the
          // card header/details instead of guessing the failing step.
          return (
            <div key={label} className={`flex items-center gap-2 text-sm ${completed || active ? 'text-info' : 'text-muted-foreground'}`}>
              {completed ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : active ? <Loader2 className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" /> : <Circle className="h-4 w-4 shrink-0" />}
              <span>{label}</span>
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/50 pt-2">
        <button
          type="button"
          onClick={() => setShowDetails(value => !value)}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={showDetails}
          aria-controls="task-start-progress-details"
        >
          {showDetails ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {showDetails ? t('Hide details') : t('More details')}
        </button>
        {isFailed && onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('Retry start')}
          </Button>
        ) : null}
      </div>

      {showDetails && (
        <div id="task-start-progress-details" className="mt-2 rounded-md bg-muted/35 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
          {isFailed ? t('启动失败，请重试') : details ?? t('Workspace setup is running in the background.')}
        </div>
      )}
    </div>
  )
}
