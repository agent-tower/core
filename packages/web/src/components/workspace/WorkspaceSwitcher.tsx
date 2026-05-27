import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, GitBranch, Layers3 } from 'lucide-react'
import { WorkspaceStatus, type TeamRun, type Workspace } from '@agent-tower/shared'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { buildWorkspaceViews } from './team-workspace-view'

interface WorkspaceSwitcherProps {
  workspaces?: Workspace[]
  teamRun?: TeamRun | null
  selectedWorkspaceId?: string | null
  onSelectWorkspace: (workspaceId: string) => void
  disabled?: boolean
  className?: string
  buttonClassName?: string
}

function statusClass(status: WorkspaceStatus) {
  switch (status) {
    case WorkspaceStatus.ACTIVE:
      return 'border-emerald-200 bg-emerald-50 text-emerald-700'
    case WorkspaceStatus.MERGED:
      return 'border-blue-200 bg-blue-50 text-blue-700'
    case WorkspaceStatus.HIBERNATED:
      return 'border-amber-200 bg-amber-50 text-amber-700'
    case WorkspaceStatus.ABANDONED:
      return 'border-neutral-200 bg-neutral-50 text-neutral-500'
  }
}

function roleClass(roleLabel: string) {
  switch (roleLabel) {
    case 'Main':
      return 'border-indigo-200 bg-indigo-50 text-indigo-700'
    case 'Child':
      return 'border-cyan-200 bg-cyan-50 text-cyan-700'
    default:
      return 'border-neutral-200 bg-neutral-50 text-neutral-600'
  }
}

function shortBranch(branchName: string) {
  if (branchName.length <= 34) return branchName
  return `...${branchName.slice(-31)}`
}

export function WorkspaceSwitcher({
  workspaces,
  teamRun,
  selectedWorkspaceId,
  onSelectWorkspace,
  disabled,
  className,
  buttonClassName,
}: WorkspaceSwitcherProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const views = useMemo(() => buildWorkspaceViews(workspaces, teamRun), [workspaces, teamRun])
  const selected = views.find((view) => view.workspace.id === selectedWorkspaceId) ?? views[0]

  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (views.length === 0) {
    return (
      <div className={cn('inline-flex h-8 items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-2.5 text-xs text-neutral-400', className)}>
        <Layers3 size={14} />
        <span>{t('No workspace')}</span>
      </div>
    )
  }

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        className={cn(
          'inline-flex h-8 max-w-[340px] items-center gap-2 rounded-md border border-neutral-200 bg-white px-2.5 text-left text-xs text-neutral-700 transition-colors hover:border-neutral-300 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50',
          buttonClassName,
        )}
        title={t('Workspace')}
      >
        <Layers3 size={14} className="shrink-0 text-neutral-500" />
        <span className={cn('shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium', roleClass(selected.roleLabel))}>
          {t(selected.roleLabel)}
        </span>
        <span className="min-w-0 truncate font-medium text-neutral-900">{t(selected.displayName)}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-neutral-500">{shortBranch(selected.workspace.branchName)}</span>
        <ChevronDown size={13} className={cn('shrink-0 text-neutral-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[420px] max-w-[calc(100vw-2rem)] rounded-lg border border-neutral-200 bg-white py-1.5 shadow-lg">
          {views.map((view) => {
            const isSelected = view.workspace.id === selected.workspace.id
            return (
              <button
                key={view.workspace.id}
                type="button"
                onClick={() => {
                  onSelectWorkspace(view.workspace.id)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-neutral-50',
                  isSelected && 'bg-neutral-50',
                )}
              >
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-500">
                  {isSelected ? <Check size={13} /> : <GitBranch size={13} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-neutral-900">{t(view.displayName)}</span>
                    <span className={cn('shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium', roleClass(view.roleLabel))}>
                      {t(view.roleLabel)}
                    </span>
                    <span className={cn('shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium', statusClass(view.workspace.status))}>
                      {view.workspace.status}
                    </span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-neutral-500">{view.workspace.branchName}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-neutral-400">
                    {view.ownerName && <span>{t('Owner')}: {view.ownerName}</span>}
                    {view.parentBranchName && <span>{t('Parent')}: {view.parentBranchName}</span>}
                    <span>{view.workspace.id.slice(0, 8)}</span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
