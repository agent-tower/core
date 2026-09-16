import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, Circle, Loader2, XCircle } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import type { SetupProgress } from '@/lib/socket/hooks/useWorkspaceSetupProgress'

export type TaskStartProgressState = {
  status: 'creating-workspace' | 'creating-session' | 'starting-session' | 'failed'
  error?: string
  setupScript?: string | null
}

interface TaskStartProgressProps {
  state?: TaskStartProgressState | null
  setupProgress?: SetupProgress | null
  sessionStarted?: boolean
  onRetry?: () => void
  /** Use the tighter spacing used by the mobile task detail. */
  compact?: boolean
}

const STEP_STATUSES = ['creating-workspace', 'creating-session', 'starting-session'] as const

/**
 * A quiet, step based progress card shown while a task's workspace and agent
 * session are being prepared. Keeping this outside TaskDetail lets desktop
 * and mobile use the same visual language and state semantics.
 */
export function TaskStartProgress({ state, setupProgress, sessionStarted = false, onRetry, compact = false }: TaskStartProgressProps) {
  const { t } = useI18n()
  const [showDetails, setShowDetails] = useState(false)
  const startFailed = state?.status === 'failed'
  const setupFailed = setupProgress?.status === 'failed'
  const isFailed = startFailed || setupFailed
  const currentIndex = state
    ? STEP_STATUSES.indexOf(state.status as typeof STEP_STATUSES[number])
    : STEP_STATUSES.length
  const startupSteps = [
    t('Preparing workspace'),
    t('Creating session'),
    t('Starting agent'),
  ]
  // Startup failures do not identify the failed phase, so keep those rows neutral.
  const setupCommands = (state?.setupScript ?? '').split('\n').map(command => command.trim()).filter(Boolean)
  const steps: { label: string; status: 'pending' | 'active' | 'completed' | 'failed'; description?: string }[] = state || sessionStarted
    ? startupSteps.map((label, index) => ({
      label,
      status: startFailed ? 'pending' : index < currentIndex ? 'completed' : index === currentIndex ? 'active' : 'pending',
    }))
    : []
  if (setupProgress || setupCommands.length > 0) {
    // Setup runs alongside session startup; it is not a later sequential step.
    steps.push({
      label: setupProgress?.status === 'running'
        ? t('Running setup ({current}/{total})', { current: setupProgress.currentIndex ?? 0, total: setupProgress.totalCommands })
        : setupProgress?.status === 'completed'
          ? t('Setup complete')
          : setupProgress?.status === 'failed'
            ? t('Setup failed')
            : t('Run setup script'),
      status: setupProgress?.status === 'running' ? 'active' : setupProgress?.status ?? 'pending',
      description: setupProgress?.currentCommand || setupCommands.join('\n'),
    })
  }
  const hasSetupOutput = Boolean(setupProgress?.output?.trim())

  if (!state && !setupProgress) return null

  return (
    <div
      className={`${compact ? 'my-2 mb-4' : 'my-3 mb-6'} mx-auto w-full max-w-2xl rounded-xl border ${isFailed ? 'border-destructive/30 bg-destructive/[0.03]' : 'border-border/70 bg-background'} px-4 py-3 text-left shadow-sm`}
      role={isFailed ? 'alert' : 'status'}
      aria-live={isFailed ? 'assertive' : 'polite'}
    >
      {isFailed && (state?.error || setupProgress?.error || startFailed) ? (
        <p className="mb-2 break-words text-xs text-destructive/80">{state?.error || setupProgress?.error || t('Agent start failed')}</p>
      ) : null}

      <div className="space-y-2">
        {steps.map(({ label, status, description }) => {
          const completed = status === 'completed'
          const active = status === 'active'
          return (
            <div key={label} className={`flex items-start gap-2 text-sm ${status === 'failed' ? 'text-destructive' : completed || active ? 'text-info' : 'text-muted-foreground'}`}>
              {completed ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : active ? <Loader2 className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" /> : status === 'failed' ? <XCircle className="h-4 w-4 shrink-0" /> : <Circle className="h-4 w-4 shrink-0" />}
              <div className="min-w-0 flex-1">
                <span>{label}</span>
                {description && <code className="mt-1 block whitespace-pre-wrap break-all rounded-md bg-muted/35 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">{description}</code>}
              </div>
            </div>
          )
        })}
      </div>

      {(hasSetupOutput || startFailed) && <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/50 pt-2">
        {hasSetupOutput ? <button
          type="button"
          onClick={() => setShowDetails(value => !value)}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={showDetails}
          aria-controls="task-start-progress-details"
        >
          {showDetails ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {showDetails ? t('Hide setup output') : t('View setup output')}
        </button> : <span />}
        {startFailed && onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('Retry start')}
          </Button>
        ) : null}
      </div>}

      {showDetails && (
        <div id="task-start-progress-details" className="mt-2 rounded-md bg-muted/35 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
          <pre className="whitespace-pre-wrap break-words font-mono">{setupProgress?.output ?? ''}</pre>
        </div>
      )}
    </div>
  )
}
