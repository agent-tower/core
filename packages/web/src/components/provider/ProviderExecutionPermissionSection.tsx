import { AlertTriangle } from 'lucide-react'
import { Switch } from '@/design-system'
import { cn } from '@/lib/utils'

interface ProviderExecutionPermissionSectionProps {
  title: string
  label: string
  enabled: boolean
  error: string | null
  warning: string
  enabledLabel: string
  disabledLabel: string
  errorLabel: string
  onToggle: (enabled: boolean) => void
}

export function ProviderExecutionPermissionSection({
  title,
  label,
  enabled,
  error,
  warning,
  enabledLabel,
  disabledLabel,
  errorLabel,
  onToggle,
}: ProviderExecutionPermissionSectionProps) {
  const state = error ? 'error' : enabled ? 'enabled' : 'disabled'

  return (
    <section
      data-state={state}
      className={cn(
        'border-t border-border pt-3',
        enabled && !error && 'border-l-2 border-l-warning pl-3',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">{title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={cn(
            'text-xs font-medium',
            error ? 'text-destructive-ink' : enabled ? 'text-warning-ink' : 'text-muted-foreground',
          )}>
            {error ? errorLabel : enabled ? enabledLabel : disabledLabel}
          </span>
          <Switch
            checked={enabled}
            disabled={!!error}
            onCheckedChange={onToggle}
            aria-label={label}
            // 视觉 20px 高，触控热区扩到 44px
            className="after:absolute after:-inset-3"
          />
        </div>
      </div>

      {enabled && !error && (
        <div className="mt-1 flex items-start gap-2 text-xs text-warning-ink">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" data-warning-icon />
          <span>{warning}</span>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive-ink">
          {error}
        </p>
      )}
    </section>
  )
}
