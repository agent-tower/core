import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { AgentType, EXECUTION_PERMISSION_MODES, type ExecutionPermissionMode, type ExecutionPermissionOption } from '@agent-tower/shared'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export const EXECUTION_PERMISSION_LABELS: Record<ExecutionPermissionMode, string> = {
  ASK: 'Ask for approval',
  AUTO_SANDBOX: 'Auto approve (sandbox)',
  FULL_ACCESS: 'Auto approve (full access)',
}

const descriptions: Record<ExecutionPermissionMode, string> = {
  ASK: 'Use native approvals. Already permitted actions can run without asking.',
  AUTO_SANDBOX: 'Use the native sandbox and automatic review. Some actions can still require approval.',
  FULL_ACCESS: 'Use native broad approval and disable the configurable sandbox. Upstream rules still apply.',
}
const codexAutoDescription = 'Codex auto-review may approve writes or destructive deletions outside the workspace, or network access, without a human approval card. Dangerous actions are not guaranteed to prompt you. The native sandbox does not fully isolate the host or MCP tools.'

export function ExecutionPermissionSelector({ value, agentType, options, error, onChange }: {
  value: ExecutionPermissionMode
  agentType?: AgentType | string
  options?: ExecutionPermissionOption[]
  error?: string | null
  onChange: (mode: ExecutionPermissionMode) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const id = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selectedOption = options?.find(option => option.mode === value)
  const description = (mode: ExecutionPermissionMode) => mode === 'AUTO_SANDBOX' && agentType === AgentType.CODEX
    ? codexAutoDescription : descriptions[mode]

  useEffect(() => {
    if (!open) return
    const handleOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open])

  return (
    <fieldset className="min-w-0 space-y-2">
      <legend id={`${id}-label`} className="mb-2 text-xs font-medium">{t('Execution permission')}</legend>
      <div ref={containerRef} className="relative" onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setOpen(false)
          triggerRef.current?.focus()
        }
      }}>
        <button
          ref={triggerRef}
          type="button"
          aria-labelledby={`${id}-label ${id}-value`}
          aria-describedby={`${id}-description`}
          aria-expanded={open}
          aria-controls={open ? `${id}-options` : undefined}
          onClick={() => setOpen(previous => !previous)}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground/80 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span id={`${id}-value`} className="min-w-0 truncate">{t(EXECUTION_PERMISSION_LABELS[value])}</span>
          <ChevronDown size={14} className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </button>

        {open && (
          <div id={`${id}-options`} role="group" aria-labelledby={`${id}-label`}
            className="absolute left-0 top-full z-50 mt-1.5 max-h-[60vh] w-full overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-[0_4px_12px_rgba(0,0,0,0.06)]">
            {EXECUTION_PERMISSION_MODES.map(mode => {
              const option = options?.find(item => item.mode === mode)
              const enabled = option?.selectable === true
              const labelId = `${id}-label-${mode}`
              const descriptionId = `${id}-description-${mode}`
              return (
                <div key={mode} tabIndex={!enabled ? 0 : undefined}
                  role={!enabled ? 'group' : undefined}
                  aria-labelledby={!enabled ? labelId : undefined}
                  aria-describedby={!enabled ? descriptionId : undefined}
                  className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  <button type="button" disabled={!enabled} aria-pressed={value === mode}
                    aria-labelledby={labelId} aria-describedby={descriptionId}
                    className="flex min-h-11 w-full items-start px-3 py-2 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    onClick={() => {
                      if (!enabled) return
                      // Reselecting the current mode also confirms legacy permission migrations.
                      onChange(mode)
                      setOpen(false)
                      triggerRef.current?.focus()
                    }}>
                    <Check size={14} className={cn('mr-2 mt-0.5 shrink-0 text-foreground', value === mode ? 'opacity-100' : 'opacity-0')} />
                    <span className="min-w-0 flex-1">
                      <span id={labelId} className={cn('block', enabled && value === mode ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                        {t(EXECUTION_PERMISSION_LABELS[mode])}
                      </span>
                      <span id={descriptionId} className="mt-0.5 block space-y-1 text-[11px] leading-snug text-muted-foreground">
                        <span className="block">{t(description(mode))}</span>
                        {!options ? <span className="block">{t('Loading permission support…')}</span> : null}
                        {option?.reasons.map(reason => <span className="block" key={reason.code}>{t(reason.message)}</span>)}
                      </span>
                    </span>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div id={`${id}-description`} className="space-y-1 text-xs text-muted-foreground">
        <p>{t(description(value))}</p>
        {!options ? <p>{t('Loading permission support…')}</p> : null}
        {selectedOption?.reasons.map(reason => <p key={reason.code}>{t(reason.message)}</p>)}
      </div>
      {options?.every(item => !item.selectable) ? <p role="alert" className="text-xs text-destructive">{t('This Agent has no available execution permission mode.')}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{t(error)}</p> : null}
      <p className="text-xs text-muted-foreground">{t('Changes apply when a new runtime starts. Running sessions keep their launch mode.')}</p>
    </fieldset>
  )
}
