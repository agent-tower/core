import { useEffect } from 'react'
import { Loader2, ShieldAlert } from 'lucide-react'
import { useResolveRuntimePermission, useRuntimeState } from '@/hooks/use-sessions'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface RuntimePermissionPromptProps {
  sessionId: string
  compact?: boolean
}

export function RuntimePermissionPrompt({ sessionId, compact = false }: RuntimePermissionPromptProps) {
  const { t } = useI18n()
  const { data } = useRuntimeState(sessionId)
  const resolvePermission = useResolveRuntimePermission()
  const permission = data?.pendingPermissions[0]
  const requestId = permission?.requestId
  const resetPermission = resolvePermission.reset

  useEffect(() => {
    resetPermission()
  }, [requestId, resetPermission])

  if (!permission) return null

  return (
    <div className={cn(
      'mb-2 border-l-2 border-warning bg-warning/5 px-3 py-2.5',
      compact && 'px-2.5 py-2',
    )}>
      <div className="flex min-w-0 items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{t('Permission required')}</div>
          <div className="mt-0.5 break-words text-xs text-muted-foreground">
            {permission.toolSummary || permission.toolName || t('The agent needs approval to continue.')}
          </div>
          {permission.actionDetails ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{permission.actionDetails}</pre> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {permission.options.map((option) => (
              <button
                key={option.optionId}
                type="button"
                disabled={resolvePermission.isPending}
                onClick={() => resolvePermission.mutate({
                  sessionId,
                  requestId: permission.requestId,
                  optionId: option.optionId,
                })}
                className={cn(
                  'inline-flex min-h-8 items-center gap-1.5 border px-3 text-xs font-medium transition-colors disabled:opacity-50',
                  option.kind.startsWith('reject')
                    ? 'border-destructive/30 text-destructive hover:bg-destructive/10'
                    : 'border-border bg-background text-foreground hover:bg-muted',
                )}
              >
                {resolvePermission.isPending
                  && resolvePermission.variables?.requestId === permission.requestId
                  && resolvePermission.variables.optionId === option.optionId
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  : null}
                {t(option.name)}
              </button>
            ))}
          </div>
          {resolvePermission.error ? (
            <div className="mt-1.5 text-xs text-destructive" role="alert">{resolvePermission.error.message}</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
