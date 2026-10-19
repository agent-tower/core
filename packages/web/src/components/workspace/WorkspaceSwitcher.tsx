import { useMemo } from 'react'
import { ChevronDown, GitBranch, Layers3 } from 'lucide-react'
import { WorkspaceStatus, type TeamRun, type Workspace } from '@agent-tower/shared'
import { Badge, Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger, type Tone } from '@/design-system'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { buildWorkspaceViews, getWorkspaceBranchLabel } from './team-workspace-view'

interface WorkspaceSwitcherProps {
  workspaces?: Workspace[]
  teamRun?: TeamRun | null
  selectedWorkspaceId?: string | null
  onSelectWorkspace: (workspaceId: string) => void
  disabled?: boolean
  className?: string
  buttonClassName?: string
}

const STATUS_TONE: Record<WorkspaceStatus, Tone> = {
  [WorkspaceStatus.ACTIVE]: 'success',
  [WorkspaceStatus.MERGED]: 'info',
  [WorkspaceStatus.HIBERNATED]: 'warning',
  [WorkspaceStatus.ABANDONED]: 'neutral',
}

function shortBranch(branchName: string) {
  if (branchName.length <= 34) return branchName
  return `...${branchName.slice(-31)}`
}

/** 工作区切换：Main / Child 只是角色标签（中性色），状态才着色 */
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
  const views = useMemo(() => buildWorkspaceViews(workspaces, teamRun), [workspaces, teamRun])
  const selected = views.find((view) => view.workspace.id === selectedWorkspaceId) ?? views[0]

  if (views.length <= 1) return null

  return (
    <div className={cn('relative', className)}>
      <Menu>
        <MenuTrigger
          disabled={disabled}
          className={cn(
            'group inline-flex h-8 max-w-[340px] items-center gap-2 rounded-md border border-border bg-background px-2.5 text-left text-xs text-foreground/80 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-40 data-[state=open]:bg-accent',
            buttonClassName,
          )}
          title={t('Workspace')}
        >
          <Layers3 size={14} className="shrink-0 text-muted-foreground" />
          <Badge size="sm" shape="tag">{t(selected.roleLabel)}</Badge>
          <span className="min-w-0 truncate font-medium text-foreground">{t(selected.displayName)}</span>
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{shortBranch(getWorkspaceBranchLabel(selected.workspace))}</span>
          <ChevronDown size={13} className="shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]:rotate-180" />
        </MenuTrigger>

        <MenuContent className="w-[420px] max-w-[calc(100vw-2rem)]">
          <MenuRadioGroup value={selected.workspace.id} onValueChange={onSelectWorkspace}>
            {views.map((view) => (
              <MenuRadioItem
                key={view.workspace.id}
                value={view.workspace.id}
                icon={<GitBranch className="mt-0.5 size-3.5" />}
                className="items-start"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{t(view.displayName)}</span>
                  <Badge size="sm" shape="tag">{t(view.roleLabel)}</Badge>
                  <Badge size="sm" tone={STATUS_TONE[view.workspace.status]}>{view.workspace.status}</Badge>
                </span>
                <span className="mt-0.5 block truncate font-mono text-[11px] font-normal text-muted-foreground">
                  {getWorkspaceBranchLabel(view.workspace)}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-normal text-muted-foreground">
                  {view.ownerName && <span>{t('Owner')}: {view.ownerName}</span>}
                  {view.parentBranchName && <span>{t('Parent')}: {view.parentBranchName}</span>}
                  <span className="font-mono text-[11px]">{view.workspace.id.slice(0, 8)}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    </div>
  )
}
