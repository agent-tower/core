import { useId, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Folder, GitBranch, ShieldCheck, ShieldOff, ShieldQuestionMark, UserRound, UsersRound } from 'lucide-react'
import { TaskPriority, WorkspaceKind, type AgentType, type ExecutionPermissionMode } from '@agent-tower/shared'
import { Button, Popover, PopoverContent, PopoverTrigger, Segmented, Tooltip } from '@/design-system'
import { useProjectWorkspaceBranches } from '@/hooks/use-workspaces'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { AgentLogo } from '@/components/agent/AgentLogo'
import { BranchSelect } from '@/components/project/BranchSelect'
import { EXECUTION_PERMISSION_LABELS } from '@/components/provider/ExecutionPermissionSelector'
import { getTaskPriorityOption, TASK_PRIORITY_OPTIONS } from './task-priority'
import { PriorityIcon } from './TaskPrioritySelect'
import { TaskOptionsToolbar, type TaskToolbarItem } from './TaskOptionsToolbar'

export interface TaskProjectOption {
  id: string
  name: string
  color?: string
  repoPath?: string
  mainBranch?: string
  isGitRepo?: boolean
  worktreeReady?: boolean
  reason?: string
}

export interface TaskProviderOption {
  id: string
  name: string
  agentType?: AgentType | string | null
  available: boolean
  permissionMode?: ExecutionPermissionMode
  reason?: string
}

const chipClass = 'h-7 min-w-0 gap-1.5 rounded-md px-2 text-xs font-medium text-foreground/80 pointer-coarse:min-h-11'
const permissions = { ASK: ShieldQuestionMark, AUTO_SANDBOX: ShieldCheck, FULL_ACCESS: ShieldOff }

function Chip({ icon, value, className }: { icon: ReactNode; value: string; className?: string }) {
  return <><span className="shrink-0 text-muted-foreground">{icon}</span><span className={cn('min-w-0 max-w-[120px] truncate', className)}>{value}</span><ChevronDown size={12} className="shrink-0 text-muted-foreground" /></>
}

function Measurement({ children, className }: { children: ReactNode; className?: string }) {
  return <Button asChild variant="ghost" size="sm" className={cn(chipClass, className)}><span>{children}</span></Button>
}

function OptionMenu({ label, trigger, disabled, className, children }: {
  label: string; trigger: ReactNode; disabled: boolean; className?: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={label}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" disabled={disabled} aria-label={label} className={cn(chipClass, className)}>{trigger}</Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent aria-label={label} className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto p-1"
        onEscapeKeyDown={event => event.stopPropagation()}>
        {children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  )
}

function Choice({ selected, disabled, onClick, children }: { selected?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" disabled={disabled} onClick={onClick}
    className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50">
    <Check size={14} className={cn('mt-0.5 shrink-0', !selected && 'invisible')} />
    <span className="min-w-0 flex-1">{children}</span>
  </button>
}

function TaskBaseBranch({ projectId, value, disabled, onChange }: { projectId: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { t } = useI18n()
  const id = useId()
  const query = useProjectWorkspaceBranches(projectId)
  return <BranchSelect id={id} label={t('Base branch')} value={value || query.data?.mainBranch || t('Project default')}
    compact branches={query.data?.branches ?? []} disabled={disabled} isRefreshing={query.isFetching}
    isLoading={query.isPending} loadError={query.isError ? t('Could not load branches. Refresh to try again.') : undefined}
    onOpen={() => { void query.refetch() }} onChange={onChange} />
}

interface Props {
  projects: TaskProjectOption[]
  providers: TaskProviderOption[]
  projectId: string
  providerId: string
  providerChanged: boolean
  isProvidersLoading?: boolean
  mode: 'SOLO' | 'TEAM'
  workspaceMode: WorkspaceKind.WORKTREE | WorkspaceKind.MAIN_DIRECTORY
  priority: TaskPriority
  baseBranch: string | undefined
  isConversation: boolean
  localProjectOnly: boolean
  gitReason?: string
  disabled: boolean
  refreshingGit: boolean
  onProjectChange: (id: string) => void
  onProviderChange: (id: string) => void
  onModeChange: (mode: 'SOLO' | 'TEAM') => void
  onWorkspaceModeChange: (mode: WorkspaceKind.WORKTREE | WorkspaceKind.MAIN_DIRECTORY) => void
  onPriorityChange: (value: TaskPriority) => void
  onBaseBranchChange: (value: string) => void
  onRefreshGit: () => Promise<void>
}

export function TaskCreationOptions(props: Props) {
  const { t } = useI18n()
  const project = props.projects.find(item => item.id === props.projectId)
  const provider = props.providers.find(item => item.id === props.providerId)
  const items: TaskToolbarItem[] = []
  const add = (id: string, label: string, trigger: ReactNode, content: (close: () => void) => ReactNode, changed = false, className?: string) => {
    items.push({ id, label, changed, measure: <Measurement className={className}>{trigger}</Measurement>,
      control: <OptionMenu label={label} trigger={trigger} disabled={props.disabled} className={className}>{content}</OptionMenu> })
  }

  if (!props.isConversation) add('project', t('Project'), <Chip icon={<Folder size={14} style={{ color: project?.color }} />} value={project?.name ?? t('Project')} />, close =>
    props.projects.map(item => <Choice key={item.id} selected={item.id === props.projectId} onClick={() => { props.onProjectChange(item.id); close() }}>{item.name}</Choice>))

  if (props.isConversation || props.mode === 'SOLO') add('provider', t('Agent'),
    <Chip icon={<AgentLogo agentType={provider?.agentType} className="size-3.5" />} value={provider?.name ?? (props.isProvidersLoading ? t('Loading...') : t('Agent'))} />, close =>
      props.providers.map(item => {
        const PermissionIcon = item.permissionMode ? permissions[item.permissionMode] : null
        return <div key={item.id} role={!item.available ? 'group' : undefined} tabIndex={!item.available ? 0 : undefined}
          aria-label={!item.available ? `${item.name}: ${t(item.reason || 'Agent executable is unavailable.')}` : undefined}>
          <Choice selected={item.id === props.providerId} disabled={!item.available} onClick={() => { props.onProviderChange(item.id); close() }}>
            <span className="flex items-start gap-2">
              <AgentLogo agentType={item.agentType} className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{item.name}{!item.available && t(' (unavailable)')}
                {item.reason && <span className="mt-0.5 block text-destructive-ink">{t(item.reason)}</span>}
              </span>
              {PermissionIcon && item.permissionMode && <span role="img" title={t('Required permission: {mode}', { mode: t(EXECUTION_PERMISSION_LABELS[item.permissionMode]) })} aria-label={t('Required permission: {mode}', { mode: t(EXECUTION_PERMISSION_LABELS[item.permissionMode]) })}><PermissionIcon size={14} /></span>}
            </span>
          </Choice>
        </div>
      }), props.providerChanged)

  const local = props.workspaceMode === WorkspaceKind.MAIN_DIRECTORY
  if (!props.isConversation && props.mode === 'SOLO') add('workspace', t('Workspace mode'),
    <Chip icon={<GitBranch size={14} />} value={local ? t('本地模式') : t('工作树模式')} />, close => <>
      <Choice selected={!local} disabled={props.localProjectOnly} onClick={() => { props.onWorkspaceModeChange(WorkspaceKind.WORKTREE); close() }}>
        <span className="block">{t('工作树模式')}</span>
        <span className="mt-0.5 block text-muted-foreground">{t('工作树隔离改动，支持 TeamRun、Merge、Rebase 和冲突解决。')}</span>
      </Choice>
      {props.localProjectOnly && <div className="px-2 pb-2 text-xs text-muted-foreground">
        <p>{props.gitReason === 'NO_HEAD' ? t('已检测到 Git，但需要先提交一次才能使用工作树模式。') : t('初始化 Git 后可使用工作树模式。')}</p>
        <Button variant="ghost" size="sm" disabled={props.refreshingGit} onClick={async () => { await props.onRefreshGit(); close() }}>{props.refreshingGit ? t('检测中...') : t('重新检测 Git 状态')}</Button>
      </div>}
      <Choice selected={local} onClick={() => { props.onWorkspaceModeChange(WorkspaceKind.MAIN_DIRECTORY); close() }}>
        <span className="block">{t('本地模式')}</span>
        <span className="mt-0.5 block text-muted-foreground">{t('本地模式会直接修改项目主目录，不会自动提交，也不能使用 Merge、Rebase 或冲突解决。')}</span>
      </Choice>
    </>, local && !props.localProjectOnly)

  if (!props.isConversation) {
    const priority = getTaskPriorityOption(props.priority)
    add('priority', t('Task priority'), <Chip icon={<PriorityIcon iconName={priority.iconName} className="size-3.5" />} value={t(priority.label)} />, close =>
      TASK_PRIORITY_OPTIONS.map(item => <Choice key={item.value} selected={item.value === props.priority} onClick={() => { props.onPriorityChange(item.value); close() }}>{item.code} · {t(item.label)}</Choice>),
      props.priority !== TaskPriority.NORMAL, priority.value === TaskPriority.NORMAL ? undefined : priority.className)
  }

  if (!props.isConversation && !props.localProjectOnly && (props.mode === 'TEAM' || !local)) {
    const value = props.baseBranch ?? project?.mainBranch ?? ''
    items.push({ id: 'branch', label: t('Base branch'), changed: Boolean(value && value !== project?.mainBranch),
      measure: <Measurement><Chip icon={<GitBranch size={14} />} value={value || t('Project default')} /></Measurement>,
      control: <TaskBaseBranch projectId={props.projectId} value={value} disabled={props.disabled} onChange={props.onBaseBranchChange} /> })
  }

  return <TaskOptionsToolbar items={items} disabled={props.disabled} fixed={!props.isConversation && (
    <Tooltip content={props.localProjectOnly
      ? t('Local projects only support local Solo tasks. Initialize Git to use worktrees and TeamRun.')
      : local ? t('TeamRun 需要工作树模式。开启团队模式时会自动切换为工作树模式。') : t('Choose solo or team mode')}>
      <span className="inline-flex">
        <Segmented size="sm" aria-label={t('Task mode')} value={props.mode} onValueChange={value => props.onModeChange(value as 'SOLO' | 'TEAM')}
          className="shrink-0 pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_button]:min-w-11"
          options={[
            { value: 'SOLO', icon: <UserRound aria-hidden="true" />, label: <span className="sr-only">{t('Solo mode')}</span>, disabled: props.disabled },
            { value: 'TEAM', icon: <UsersRound aria-hidden="true" />, label: <span className="sr-only">{t('Team mode')}</span>, disabled: props.disabled || props.localProjectOnly },
          ]} />
      </span>
    </Tooltip>
  )} />
}
