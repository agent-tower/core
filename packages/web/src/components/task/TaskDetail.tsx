import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useQueryClient } from '@tanstack/react-query'
import { SessionStatus, WorkspaceStatus, type Session, type TaskBody } from '@agent-tower/shared'
import type { ConflictOp } from '@agent-tower/shared'
import {
  ServerEvents,
  ClientEvents,
  type SessionCompletedPayload,
  type TaskUpdatedPayload,
  type WorkspaceCommitMessageUpdatedPayload,
  type WorkspaceHibernatedPayload,
} from '@agent-tower/shared/socket'
import { LogStream } from '@/components/agent'
import { TodoPanel } from '@/components/agent'
import { TokenUsageIndicator } from '@/components/agent'
import { IconRunning, IconReview, IconPending, IconDone, IconCancelled } from '@/components/agent'
import { Paperclip, ArrowUp, ArrowDown, ArrowLeft, Play, Square, Code2, Trash2, MoreVertical, RotateCcw, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RoomTimeline } from '@/components/team/RoomTimeline'
import { TeamStatusPanel } from '@/components/team/TeamStatusPanel'
import { WorkspacePanel, type WorkspaceTab } from '@/components/workspace/WorkspacePanel'
import {
  canRunWorkspaceGitOperations,
  getWorkspaceBranchLabel,
  getWorkspaceWorkingDir,
  getWorkspaceMergeTargetBranch,
  resolveDefaultWorkspaceId,
} from '@/components/workspace/team-workspace-view'
import { teamRunQueryKeys, useTaskTeamRun, useRoomMessages, usePostRoomMessage } from '@/hooks/use-team-run'
import { useWorkspaces, useOpenInEditor, useGitStatus, useCreateWorkspace, useReactivateWorkspace } from '@/hooks/use-workspaces'
import { useGitChanges } from '@/hooks/use-git'
import { queryKeys } from '@/hooks/query-keys'
import { apiClient } from '@/lib/api-client'
import { useNormalizedLogs } from '@/lib/socket/hooks/useNormalizedLogs'
import { useWorkspaceSetupProgress } from '@/lib/socket/hooks/useWorkspaceSetupProgress'
import { socketManager } from '@/lib/socket/manager'
import { useGitVisibilityStore } from '@/stores/git-visibility-store'
import { useSendMessage, useStopSession, useStartSession } from '@/hooks/use-sessions'
import { useRetryTask, useTaskBody } from '@/hooks/use-tasks'
import { useProviders } from '@/hooks/use-providers'
import { useTodos } from '@/hooks/use-todos'
import { useTokenUsage } from '@/hooks/useTokenUsage'
import { useAttachments } from '@/hooks/use-attachments'
import { AttachmentPreview } from '@/components/ui/AttachmentPreview'
import { StartAgentDialog } from './StartAgentDialog'
import { getSessionTokenUsage, SessionReadonlyMeta } from './SessionReadonlyMeta'
import { CreateTeamRunDialog } from '@/components/team/CreateTeamRunDialog'
import { ProviderSelector } from './ProviderSelector'
import { SlashCommandPopover } from './SlashCommandPopover'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DeleteTaskConfirmDialog } from './DeleteTaskConfirmDialog'
import { ConflictBanner } from '@/components/workspace/ConflictBanner'
import { ResolveConflictsDialog } from '@/components/workspace/ResolveConflictsDialog'
import { WorkspaceChangeSummaryBar } from '@/components/workspace/WorkspaceChangeSummaryBar'
import { type ConflictDetails } from '@/components/workspace/GitOperationsDialog'
import type { UITaskDetailData } from './types'
import { UITaskStatus } from './types'
import { useSlashCommandMenu } from './useSlashCommandMenu'
import { useSkillMentionMenu } from './useSkillMentionMenu'
import { Streamdown } from 'streamdown'
import type { UrlTransform } from 'streamdown'
import { useI18n } from '@/lib/i18n'
import { streamdownComponents } from '@/lib/streamdown-components'
import 'streamdown/styles.css'

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

/**
 * 将磁盘绝对路径转换为 HTTP URL，使浏览器能显示附件图片。
 */
const attachmentUrlTransform: UrlTransform = (url) => {
  if (url.includes('://')) return url
  if (url.startsWith('/api/')) return url
  if (url.startsWith('/')) {
    return `${API_BASE_URL}/attachments/by-path?path=${encodeURIComponent(url)}`
  }
  return url
}

interface TaskDetailProps {
  task: UITaskDetailData | null
  /** 删除任务回调 — 传入 taskId */
  onDeleteTask?: (taskId: string) => void
  /** 删除中状态 */
  isDeleting?: boolean
  /** 状态变更回调 */
  onTaskStatusChange?: (taskId: string, newStatus: UITaskStatus) => void
  /** 自动启动后台状态。创建 task 成功后不阻塞 UI，只在详情区展示后续启动进度。 */
  autoStartState?: {
    status: 'creating-workspace' | 'creating-session' | 'starting-session' | 'failed'
    error?: string
  } | null
  /** 自动启动失败后，用户手动重试成功时通知父级清理后台失败状态。 */
  onAutoStartRecovered?: (taskId: string) => void
}

// ============ Layout Constants ============

const WORKSPACE_PANEL_MIN_WIDTH = 520
const WORKSPACE_PANEL_RAIL_WIDTH = 48
const WORKSPACE_RESIZER_WIDTH = 4
const CHAT_PANEL_MIN_WIDTH = 420

// ============ Empty State (hoisted JSX) ============

function EmptyState() {
  const { t } = useI18n()

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-background text-muted-foreground/70 select-none">
      <div className="w-16 h-16 bg-muted/50 rounded-2xl border border-border/60 flex items-center justify-center mb-6">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="text-muted-foreground/50"
        >
          <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="currentColor" />
          <path
            d="M2 17L12 22L22 17"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M2 12L12 17L22 12"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h3 className="text-foreground font-medium mb-2 text-lg">Agent Tower</h3>
      <p className="text-sm max-w-sm text-center text-muted-foreground leading-relaxed">
        {t('Select a task from the sidebar to view logs, monitor execution, or interact with an agent.')}
      </p>
    </div>
  )
}

// ============ Status Badge Helper ============

// 状态色语义统一见 .design/DESIGN.md §2.4 与 status-styles.ts
const STATUS_OPTIONS = [
  { status: UITaskStatus.Review, className: 'bg-warning/10 text-warning', hoverClass: 'hover:bg-warning/15', icon: <IconReview className="w-3 h-3" /> },
  { status: UITaskStatus.Running, className: 'bg-info/10 text-info', hoverClass: 'hover:bg-info/15', icon: <IconRunning className="w-3 h-3" /> },
  { status: UITaskStatus.Pending, className: 'bg-muted/50 text-muted-foreground', hoverClass: 'hover:bg-muted', icon: <IconPending className="w-3 h-3" /> },
  { status: UITaskStatus.Done, className: 'bg-success/10 text-success', hoverClass: 'hover:bg-success/15', icon: <IconDone className="w-3 h-3" /> },
  { status: UITaskStatus.Cancelled, className: 'bg-muted/50 text-muted-foreground', hoverClass: 'hover:bg-border', icon: <IconCancelled className="w-3 h-3" /> },
] as const

function StatusBadge({ status, onChangeStatus }: { status: UITaskStatus; onChangeStatus?: (newStatus: UITaskStatus) => void }) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  const current = STATUS_OPTIONS.find(o => o.status === status)!

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => onChangeStatus && setIsOpen(v => !v)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${current.className} ${onChangeStatus ? 'cursor-pointer hover:opacity-80' : ''}`}
      >
        {current.icon}
        <span>{t(status)}</span>
        {onChangeStatus && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className={`ml-0.5 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
            <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-40 bg-background rounded-lg border border-border shadow-lg z-50 py-1 animate-in fade-in zoom-in-95 duration-100">
          {STATUS_OPTIONS.filter(o => o.status !== status).map(opt => (
            <button
              key={opt.status}
              onClick={() => { onChangeStatus?.(opt.status); setIsOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium transition-colors ${opt.hoverClass}`}
            >
              <span className={opt.className.split(' ').find(c => c.startsWith('text-'))}>{opt.icon}</span>
              <span className="text-foreground/80">{t(opt.status)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AutoStartStatus({
  state,
  onRetry,
}: {
  state: NonNullable<TaskDetailProps['autoStartState']>
  onRetry?: () => void
}) {
  const { t } = useI18n()
  const label = state.status === 'creating-workspace'
    ? t('Creating Workspace...')
    : state.status === 'creating-session'
      ? t('Creating Session...')
      : state.status === 'starting-session'
        ? t('Starting Agent...')
        : t('启动 Agent 失败')

  if (state.status === 'failed') {
    return (
      <div className="mb-6 max-w-sm rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-left">
        <p className="text-sm font-medium text-destructive">{label}</p>
        {state.error ? (
          <p className="mt-1 text-xs text-destructive/80 break-words">{state.error}</p>
        ) : null}
        {onRetry ? (
          <Button size="sm" variant="outline" className="mt-3" onClick={onRetry}>
            <Play size={14} className="mr-1.5" />
            {t('重试启动 Agent')}
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="mb-6 flex items-center gap-2 rounded-full border border-border bg-muted/30 px-3 py-1.5 text-sm text-muted-foreground">
      <svg className="h-3.5 w-3.5 animate-spin shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <span>{label}</span>
    </div>
  )
}

// ============ TaskDetail Component ============

export function TaskDetail({ task, onDeleteTask, isDeleting, onTaskStatusChange, autoStartState, onAutoStartRecovered }: TaskDetailProps) {
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const [isStartDialogOpen, setIsStartDialogOpen] = useState(false)
  const [isCreateTeamRunDialogOpen, setIsCreateTeamRunDialogOpen] = useState(false)
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false)
  const [isRetryConfirmOpen, setIsRetryConfirmOpen] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)
  const [isResolveDialogOpen, setIsResolveDialogOpen] = useState(false)
  const [pendingConflictDetails, setPendingConflictDetails] = useState<ConflictDetails | null>(null)
  const workspacePanelTabRef = useRef<{ setTab: (tab: WorkspaceTab) => void } | null>(null)
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false)
  const [focusedInvocationSessionId, setFocusedInvocationSessionId] = useState<string | null>(null)
  const [explicitWorkspaceId, setExplicitWorkspaceId] = useState<string | undefined>(undefined)
  // retry 后强制清空 session 显示，等待用户重新 Start Agent
  const [isJustRetried, setIsJustRetried] = useState(false)
  const inputContainerRef = useRef<HTMLDivElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    resize: 'smooth',
    initial: 'instant',
  })

  // Layout state
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState(false)
  const [workspaceContentWidth, setWorkspaceContentWidth] = useState(WORKSPACE_PANEL_MIN_WIDTH)
  const [isWorkspaceResizing, setIsWorkspaceResizing] = useState(false)
  const startResizeXRef = useRef<number>(0)
  const startWorkspaceWidthRef = useRef<number>(WORKSPACE_PANEL_MIN_WIDTH)
  const mainAreaRef = useRef<HTMLDivElement>(null)

  // ============ Session Discovery ============

  const { data: workspaces, isLoading: isLoadingWorkspaces } = useWorkspaces(task?.id ?? '')
  const setupProgress = useWorkspaceSetupProgress(task?.id)
  const { data: taskTeamRun } = useTaskTeamRun(task?.id ?? '')
  const { data: roomMessages } = useRoomMessages(taskTeamRun?.id ?? '')
  const postRoomMessage = usePostRoomMessage(taskTeamRun?.id ?? '')
  const teamRun = taskTeamRun ?? null
  const isTeamRunMode = Boolean(teamRun)
  const showCreateTeamRunEntry = taskTeamRun === null
  const shouldLoadTaskBody = Boolean(task?.id && taskTeamRun === null)
  const { data: taskBody, isLoading: isLoadingTaskBody } = useTaskBody(task?.id ?? '', shouldLoadTaskBody)

  // task 切换时清空 isJustRetried
  useEffect(() => {
    setIsJustRetried(false)
    setFocusedInvocationSessionId(null)
    setExplicitWorkspaceId(undefined)
  }, [task?.id])

  const resolvedWorkspaceId = useMemo(
    () => resolveDefaultWorkspaceId(workspaces, teamRun, explicitWorkspaceId),
    [explicitWorkspaceId, teamRun, workspaces],
  )

  useEffect(() => {
    if (explicitWorkspaceId && !workspaces?.some((workspace) => workspace.id === explicitWorkspaceId)) {
      setExplicitWorkspaceId(undefined)
    }
  }, [explicitWorkspaceId, workspaces])

  const selectedWorkspace = useMemo(
    () => workspaces?.find((workspace) => workspace.id === resolvedWorkspaceId),
    [resolvedWorkspaceId, workspaces],
  )

  const selectedWorkspaceOperationId = selectedWorkspace?.status === WorkspaceStatus.ACTIVE
    ? selectedWorkspace.id
    : undefined
  const canRunSelectedWorkspaceGitOperations = canRunWorkspaceGitOperations(selectedWorkspace, teamRun)

  // 新 ACTIVE workspace session 出现后自动解除 retry 锁定
  useEffect(() => {
    if (!isJustRetried || !workspaces) return
    const hasNewActiveSession = workspaces.some(
      (ws) => ws.status === 'ACTIVE' && ws.sessions && ws.sessions.length > 0
    )
    if (hasNewActiveSession) setIsJustRetried(false)
  }, [workspaces, isJustRetried])

  // Find the latest relevant session from workspaces.
  // We prioritize RUNNING > PENDING > terminal states, and within each bucket
  // pick the newest by available timestamps to avoid selecting stale sessions.
  // When no ACTIVE workspace has sessions, fall back to MERGED workspace sessions
  // so that communication history remains visible after merging code.
  const activeSession = useMemo(() => {
    // retry 后强制清空，等待用户重新 Start Agent
    if (isJustRetried) return null

    if (!workspaces) return null

    const getSessionTime = (session: Session): number => {
      const createdAt = (session as Session & { createdAt?: string }).createdAt
      const time =
        session.endedAt ??
        session.startedAt ??
        createdAt
      if (!time) return 0
      const ts = Date.parse(time)
      return Number.isNaN(ts) ? 0 : ts
    }

    const pickLatest = (sessions: Session[], statuses: SessionStatus[]): Session | null => {
      const candidates = sessions.filter((s) => statuses.includes(s.status))
      if (candidates.length === 0) return null
      return candidates.sort((a, b) => getSessionTime(b) - getSessionTime(a))[0] ?? null
    }

    // First try ACTIVE workspaces
    const activeSessions: Session[] = workspaces
      .filter((ws) => ws.status === 'ACTIVE' && Array.isArray(ws.sessions))
      .flatMap((ws) => ws.sessions ?? [])

    const fromActive =
      pickLatest(activeSessions, [SessionStatus.RUNNING]) ??
      pickLatest(activeSessions, [SessionStatus.PENDING]) ??
      pickLatest(activeSessions, [SessionStatus.COMPLETED, SessionStatus.FAILED, SessionStatus.CANCELLED])

    if (fromActive) return fromActive

    // Fallback: show the latest session from historical workspaces (read-only history)
    const historySessions: Session[] = workspaces
      .filter((ws) => (ws.status === 'MERGED' || ws.status === 'ABANDONED' || ws.status === 'HIBERNATED') && Array.isArray(ws.sessions))
      .flatMap((ws) => ws.sessions ?? [])

    return pickLatest(historySessions, [SessionStatus.COMPLETED, SessionStatus.FAILED, SessionStatus.CANCELLED])
  }, [workspaces, isJustRetried])

  const sessionId = activeSession?.id ?? ''
  const logSessionId = isTeamRunMode ? focusedInvocationSessionId ?? '' : sessionId

  const focusedSession = useMemo(() => {
    if (!focusedInvocationSessionId || !workspaces) return null
    for (const workspace of workspaces) {
      const match = workspace.sessions?.find((session) => session.id === focusedInvocationSessionId)
      if (match) return match
    }
    return null
  }, [focusedInvocationSessionId, workspaces])

  const focusedInvocation = useMemo(() => {
    if (!focusedInvocationSessionId || !teamRun?.invocations) return null
    const matches = teamRun.invocations.filter((invocation) => invocation.sessionId === focusedInvocationSessionId)
    if (matches.length === 0) return null
    return matches.sort((a, b) => {
      const aTime = Date.parse(a.updatedAt ?? a.createdAt ?? '')
      const bTime = Date.parse(b.updatedAt ?? b.createdAt ?? '')
      return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime)
    })[0] ?? null
  }, [focusedInvocationSessionId, teamRun?.invocations])

  const focusedInvocationMember = useMemo(() => {
    if (!focusedInvocation?.memberId || !teamRun?.members) return null
    return teamRun.members.find((member) => member.id === focusedInvocation.memberId) ?? null
  }, [focusedInvocation?.memberId, teamRun?.members])

  const displayedSession = focusedInvocationSessionId ? focusedSession : activeSession ?? null
  const isSessionActive = displayedSession?.status === SessionStatus.RUNNING || displayedSession?.status === SessionStatus.PENDING
  const isProjectReadOnly = Boolean(task?.projectArchivedAt)
  const isProjectRepoDeleted = Boolean(task?.projectRepoDeletedAt)
  const projectReadOnlyMessage = isProjectRepoDeleted
    ? t('项目已删除，本地仓库文件也已清理。恢复项目并重新绑定仓库后才能继续操作。')
    : t('项目已删除。恢复项目后才能继续创建会话或修改任务。')

  // ============ Provider Info ============

  const { data: providers } = useProviders()
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)

  // 当 session 的 providerId 变化时，同步 selectedProviderId
  useEffect(() => {
    setSelectedProviderId(activeSession?.providerId ?? null)
  }, [activeSession?.providerId])

  // Whether the displayed session comes from a MERGED workspace (read-only history, no active worktree)
  const isReadOnlySession = useMemo(() => {
    if (!activeSession || !workspaces) return false
    const hasActiveWs = workspaces.some((ws) => ws.status === 'ACTIVE' && ws.sessions?.some((s) => s.id === activeSession.id))
    return !hasActiveWs
  }, [activeSession, workspaces])

  // Derive workingDir from the selected workspace's actual execution directory.
  const workingDir = useMemo(() => {
    if (!workspaces || isJustRetried) return undefined
    if (selectedWorkspace) return getWorkspaceWorkingDir(selectedWorkspace)
    for (const ws of workspaces) {
      if (ws.status === 'ACTIVE' && getWorkspaceWorkingDir(ws)) {
        return getWorkspaceWorkingDir(ws)
      }
    }
    return getWorkspaceWorkingDir(workspaces[0])
  }, [isJustRetried, selectedWorkspace, workspaces])

  const slashCommandMenu = useSlashCommandMenu({
    agentType: activeSession?.agentType,
    workingDir,
    input,
    setInput,
    textareaRef,
    minHeight: 60,
    maxHeight: 300,
  })

  const skillMentionMenu = useSkillMentionMenu({
    agentType: activeSession?.agentType,
    workingDir,
    input,
    setInput,
    textareaRef,
    minHeight: 60,
    maxHeight: 300,
  })

  // ============ Git Status ============

  const setVisibleGitContext = useGitVisibilityStore((state) => state.setVisibleContext)
  const shouldLoadTaskDetailGitData = Boolean(
    canRunSelectedWorkspaceGitOperations
    && selectedWorkspaceOperationId
    && workingDir
    && !isProjectReadOnly
  )
  const { data: gitStatus, isLoading: isGitStatusLoading } = useGitStatus(selectedWorkspaceOperationId ?? '', {
    enabled: shouldLoadTaskDetailGitData,
  })
  const {
    data: gitChangesData,
  } = useGitChanges(workingDir, {
    enabled: shouldLoadTaskDetailGitData,
  })

  useEffect(() => {
    if (isWorkspaceOpen || !shouldLoadTaskDetailGitData || !selectedWorkspaceOperationId || !workingDir) {
      return
    }

    setVisibleGitContext({
      workspaceId: selectedWorkspaceOperationId,
      workingDir,
      tab: 'changes',
    })

    return () => {
      setVisibleGitContext(null)
    }
  }, [isWorkspaceOpen, selectedWorkspaceOperationId, setVisibleGitContext, shouldLoadTaskDetailGitData, workingDir])

  // Collect sessions from active workspace for ResolveConflictsDialog
  const selectedWorkspaceSessions = selectedWorkspace?.sessions ?? []

  const selectedWorkspaceBranch = getWorkspaceBranchLabel(selectedWorkspace)

  const selectedWorkspaceCommitMessage = selectedWorkspace?.commitMessage
  const selectedWorkspaceMergeTargetBranch = useMemo(
    () => getWorkspaceMergeTargetBranch(selectedWorkspace, workspaces, task?.mainBranch ?? ''),
    [selectedWorkspace, task?.mainBranch, workspaces],
  )
  const conflictDetails = useMemo<ConflictDetails | null>(() => {
    if (gitStatus?.conflictOp && gitStatus.conflictedFiles.length > 0) {
      return {
        conflictOp: gitStatus.conflictOp as ConflictOp,
        conflictedFiles: gitStatus.conflictedFiles,
      }
    }

    return pendingConflictDetails
  }, [gitStatus?.conflictOp, gitStatus?.conflictedFiles, pendingConflictDetails])
  const resolveConflictWorkspaceId = conflictDetails?.targetWorkspaceId ?? selectedWorkspaceOperationId
  const resolveConflictWorktreePath = conflictDetails?.targetWorktreePath ?? selectedWorkspace?.worktreePath
  const resolveConflictSourceBranch = conflictDetails?.sourceBranch ?? selectedWorkspaceBranch
  const resolveConflictTargetBranch = conflictDetails?.targetBranch ?? selectedWorkspaceMergeTargetBranch

  // ============ Query Client & Mutations ============

  const queryClient = useQueryClient()
  const ensureTaskBody = useCallback(async () => {
    if (!task?.id) return null
    return queryClient.fetchQuery({
      queryKey: queryKeys.tasks.body(task.id),
      queryFn: () => apiClient.get<TaskBody>(`/tasks/${task.id}/body`),
    })
  }, [queryClient, task?.id])
  const refreshWorkspaces = useCallback(() => {
    if (!task?.id) return Promise.resolve()
    return queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(task.id) })
  }, [task?.id, queryClient])

  // Close more-menu on outside click
  useEffect(() => {
    if (!isMoreMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setIsMoreMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isMoreMenuOpen])

  const sendMessageMutation = useSendMessage()
  const openInEditorMutation = useOpenInEditor()
  const retryTaskMutation = useRetryTask()
  const createWorkspaceMutation = useCreateWorkspace(task?.id ?? '')
  const startSessionMutation = useStartSession()
  const reactivateWorkspaceMutation = useReactivateWorkspace()

  // Detect if the task has a hibernated workspace (and no active one)
  const hibernatedWorkspace = useMemo(() => {
    if (!workspaces) return null
    const hasActive = workspaces.some(ws => ws.status === 'ACTIVE')
    if (hasActive) return null
    return workspaces.find(ws => ws.status === 'HIBERNATED') ?? null
  }, [workspaces])

  // Auto-reactivate hibernated workspace when entering TaskDetail
  const reactivatingRef = useRef<string | null>(null)
  useEffect(() => {
    if (!hibernatedWorkspace) return
    if (reactivatingRef.current === hibernatedWorkspace.id) return
    if (reactivateWorkspaceMutation.isPending) return

    reactivatingRef.current = hibernatedWorkspace.id
    reactivateWorkspaceMutation.mutate(hibernatedWorkspace.id, {
      onSettled: () => { reactivatingRef.current = null },
    })
  }, [hibernatedWorkspace, reactivateWorkspaceMutation])

  const handleRetryTask = useCallback(async () => {
    if (!task?.id) return

    const retryProviderId = activeSession?.providerId
      ?? providers?.find(p => p.availability.type !== 'NOT_FOUND')?.provider.id
    if (!retryProviderId) return

    setIsRetryConfirmOpen(false)
    setIsRetrying(true)
    try {
      const body = await ensureTaskBody()
      const prompt = body?.prompt ?? task.title
      await retryTaskMutation.mutateAsync(task.id)
      setIsJustRetried(true)

      const workspace = await createWorkspaceMutation.mutateAsync({})

      const session = await apiClient.post<{ id: string }>(
        `/workspaces/${workspace.id}/sessions`,
        { providerId: retryProviderId, prompt },
      )

      await startSessionMutation.mutateAsync(session.id)

      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(task.id) })
    } catch (err) {
      console.error('[retry] failed:', err)
      setIsJustRetried(false)
    } finally {
      setIsRetrying(false)
    }
  }, [task?.id, task?.title, activeSession?.providerId, providers, ensureTaskBody,
      retryTaskMutation, createWorkspaceMutation, startSessionMutation, queryClient])

  const handleOpenStartDialog = useCallback(async () => {
    if (!task?.id) return
    await ensureTaskBody()
    setIsStartDialogOpen(true)
  }, [ensureTaskBody, task?.id])

  const handleOpenInIde = useCallback(() => {
    if (!selectedWorkspace?.id) return
    openInEditorMutation.mutate({ workspaceId: selectedWorkspace.id })
  }, [openInEditorMutation, selectedWorkspace?.id])

  const handleDeleteTask = useCallback(() => {
    if (!task?.id || !onDeleteTask) return
    onDeleteTask(task.id)
    setIsDeleteConfirmOpen(false)
  }, [task?.id, onDeleteTask])

  const handleViewInvocationSession = useCallback((invocationSessionId: string) => {
    setFocusedInvocationSessionId(invocationSessionId)
    requestAnimationFrame(() => {
      scrollToBottom()
    })
  }, [scrollToBottom])

  const handleBackToTeamRoom = useCallback(() => {
    setFocusedInvocationSessionId(null)
  }, [])

  const handleOpenResolveConflicts = useCallback((details?: ConflictDetails) => {
    setPendingConflictDetails(details ?? null)
    setIsResolveDialogOpen(true)
  }, [])

  const handlePostRoomMessage = useCallback(
    (input: Parameters<typeof postRoomMessage.mutateAsync>[0]) => postRoomMessage.mutateAsync(input),
    [postRoomMessage],
  )

  const invalidateTeamRunQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.all })
  }, [queryClient])

  // ============ WebSocket Log Stream ============

  const {
    isConnected,
    isLoadingSnapshot,
    logs,
    entries,
    attach,
  } = useNormalizedLogs({
    sessionId: logSessionId,
    sessionStatus: displayedSession?.status,
    onExit: useCallback(() => {
      // Agent PTY 退出后，刷新 workspaces query 让 isSessionActive 更新（停止按钮变回发送按钮）
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
    }, [queryClient]),
  })

  // ---- Task room 订阅（仅依赖 taskId，不受 sessionId 变化影响）----
  // 拆分出来避免 sessionId 变化时 unsubscribe/resubscribe task room，
  // 否则会导致 useWorkspaceSetupProgress 等依赖 task room 的 hook 丢失事件。
  useEffect(() => {
    if (!task?.id) return
    const socket = socketManager.connect()
    socket.emit(ClientEvents.SUBSCRIBE, { topic: 'task', id: task.id })

    const handleTaskUpdated = (payload: TaskUpdatedPayload) => {
      if (payload.taskId !== task.id) return
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      invalidateTeamRunQueries()
    }
    const handleWorkspaceCommitMessageUpdated = (payload: WorkspaceCommitMessageUpdatedPayload) => {
      if (payload.taskId !== task.id) return
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(task.id) })
      invalidateTeamRunQueries()
    }
    const handleWorkspaceHibernated = (payload: WorkspaceHibernatedPayload) => {
      if (payload.taskId !== task.id) return
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(task.id) })
      invalidateTeamRunQueries()
    }
    socket.on(ServerEvents.TASK_UPDATED, handleTaskUpdated)
    socket.on(ServerEvents.WORKSPACE_COMMIT_MESSAGE_UPDATED, handleWorkspaceCommitMessageUpdated)
    socket.on(ServerEvents.WORKSPACE_HIBERNATED, handleWorkspaceHibernated)

    return () => {
      socket.off(ServerEvents.TASK_UPDATED, handleTaskUpdated)
      socket.off(ServerEvents.WORKSPACE_COMMIT_MESSAGE_UPDATED, handleWorkspaceCommitMessageUpdated)
      socket.off(ServerEvents.WORKSPACE_HIBERNATED, handleWorkspaceHibernated)
      socket.emit(ClientEvents.UNSUBSCRIBE, { topic: 'task', id: task.id })
    }
  }, [task?.id, queryClient, invalidateTeamRunQueries])

  // ---- Session 事件监听（依赖 sessionId）----
  useEffect(() => {
    if (!logSessionId) return
    const socket = socketManager.connect()

    const handleSessionCompleted = (payload: SessionCompletedPayload) => {
      if (payload.sessionId !== logSessionId) return
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      invalidateTeamRunQueries()
    }
    socket.on(ServerEvents.SESSION_COMPLETED, handleSessionCompleted)

    return () => {
      socket.off(ServerEvents.SESSION_COMPLETED, handleSessionCompleted)
    }
  }, [logSessionId, queryClient, invalidateTeamRunQueries])

  // Extract agent todos from the log stream
  const { todos } = useTodos(entries)

  // Attachments (file upload, paste, drag-drop)
  const { files: attachmentFiles, addFiles, removeFile, clear: clearAttachments, buildMarkdownLinks, hasFiles: hasAttachments, isUploading } = useAttachments()

  // Token usage — 取最新一条，回退到持久化值
  const initialTokenUsage = useMemo(() => {
    return getSessionTokenUsage(displayedSession)
  }, [displayedSession?.tokenUsage])
  const tokenUsage = useTokenUsage(logs, initialTokenUsage)

  // Auto-attach: 当 sessionId 或连接状态变化时自动 attach
  useEffect(() => {
    if (logSessionId && isConnected) {
      attach()
    }
  }, [logSessionId, isConnected, attach])

  // Note: no explicit detach effect needed here.
  // useNormalizedLogs' internal cleanup already sends UNSUBSCRIBE for the
  // old sessionId when sessionId changes (using the closure's stale value,
  // which is correct). An external detach() here would use the NEW sessionId
  // and incorrectly unsubscribe from the session we just attached to.

  // Snap to bottom instantly when switching tasks (no smooth animation)
  const prevTaskIdRef = useRef(task?.id)
  useEffect(() => {
    if (prevTaskIdRef.current !== task?.id && scrollRef.current) {
      const el = scrollRef.current
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
    }
    prevTaskIdRef.current = task?.id
  }, [task?.id, scrollRef])

  // ============ Session Actions ============

  const stopSession = useStopSession()

  const sendingRef = useRef(false)
  const handleSend = useCallback(async () => {
    if ((!input.trim() && !hasAttachments) || !logSessionId || sendingRef.current || isUploading) return
    sendingRef.current = true

    // 拼接附件 markdown 链接到消息末尾
    const attachmentLinks = buildMarkdownLinks()
    const message = [input.trim(), attachmentLinks].filter(Boolean).join('\n\n')

    setInput('')
    clearAttachments()
    if (textareaRef.current) {
      textareaRef.current.style.height = '60px'
    }

      // 统一入口：无论 session 是 RUNNING 还是 COMPLETED/CANCELLED，
      // 都调同一个 sendMessage。后端自动处理 PTY 状态。
    sendMessageMutation.mutate(
      { id: logSessionId, message, providerId: selectedProviderId ?? undefined },
      {
        onSuccess: () => {
          // 确保 snapshot 已加载（全量广播下 patch 已实时到达，attach 通常为 no-op）
          attach()
        },
        onSettled: () => {
          sendingRef.current = false
        },
      }
    )
  }, [input, logSessionId, sendMessageMutation, attach, hasAttachments, isUploading, buildMarkdownLinks, clearAttachments, selectedProviderId])

  const handleStop = useCallback(async () => {
    if (!logSessionId) return
    await stopSession.mutateAsync(logSessionId)
    queryClient.invalidateQueries({ queryKey: ['workspaces'] })
  }, [logSessionId, stopSession, queryClient])

  // ============ File Upload Handlers ============

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (fileList && fileList.length > 0) {
      addFiles(Array.from(fileList))
    }
    // 重置 input 以便再次选择同一文件
    e.target.value = ''
  }, [addFiles])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }, [addFiles])

  const [isDragOver, setIsDragOver] = useState(false)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const fileList = e.dataTransfer.files
    if (fileList.length > 0) {
      addFiles(Array.from(fileList))
    }
  }, [addFiles])

  const clampWorkspaceContentWidth = useCallback((width: number) => {
    const availableWidth = mainAreaRef.current?.getBoundingClientRect().width
      ?? (typeof window !== 'undefined' ? window.innerWidth : undefined)
    const maxWidth = availableWidth
      ? Math.max(
          WORKSPACE_PANEL_MIN_WIDTH,
          availableWidth - WORKSPACE_PANEL_RAIL_WIDTH - WORKSPACE_RESIZER_WIDTH - CHAT_PANEL_MIN_WIDTH,
        )
      : WORKSPACE_PANEL_MIN_WIDTH
    return Math.max(WORKSPACE_PANEL_MIN_WIDTH, Math.min(Math.round(width), maxWidth))
  }, [])

  const handleWorkspaceResizeMove = useCallback((e: MouseEvent) => {
    const deltaX = e.clientX - startResizeXRef.current
    setWorkspaceContentWidth(clampWorkspaceContentWidth(startWorkspaceWidthRef.current - deltaX))
  }, [clampWorkspaceContentWidth])

  const handleWorkspaceResizeEnd = useCallback(() => {
    setIsWorkspaceResizing(false)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  useEffect(() => {
    if (!isWorkspaceResizing) return

    document.addEventListener('mousemove', handleWorkspaceResizeMove)
    document.addEventListener('mouseup', handleWorkspaceResizeEnd)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    return () => {
      document.removeEventListener('mousemove', handleWorkspaceResizeMove)
      document.removeEventListener('mouseup', handleWorkspaceResizeEnd)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [handleWorkspaceResizeEnd, handleWorkspaceResizeMove, isWorkspaceResizing])

  const handleWorkspaceResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    startResizeXRef.current = e.clientX
    startWorkspaceWidthRef.current = workspaceContentWidth
    setIsWorkspaceResizing(true)
  }, [workspaceContentWidth])

  useEffect(() => {
    if (!isWorkspaceOpen || isWorkspaceResizing) return
    setWorkspaceContentWidth((current) => clampWorkspaceContentWidth(current))
  }, [clampWorkspaceContentWidth, isWorkspaceOpen, isWorkspaceResizing])

  useEffect(() => {
    if (!isWorkspaceOpen) return

    const handleResize = () => {
      setWorkspaceContentWidth((current) => clampWorkspaceContentWidth(current))
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [clampWorkspaceContentWidth, isWorkspaceOpen])

  const handleOpenWorkspaceChanges = useCallback(() => {
    setWorkspaceContentWidth((current) => clampWorkspaceContentWidth(current))
    setIsWorkspaceOpen(true)
    requestAnimationFrame(() => {
      workspacePanelTabRef.current?.setTab('review')
    })
  }, [clampWorkspaceContentWidth])

  // textarea auto-resize in onChange handler (not useEffect)
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    const scrollHeight = el.scrollHeight
    el.style.height = `${Math.max(60, Math.min(scrollHeight, 300))}px`
  }, [])

  const workspaceChangeSummaryBar = shouldLoadTaskDetailGitData && selectedWorkspaceOperationId ? (
    <WorkspaceChangeSummaryBar
      workspaceId={selectedWorkspaceOperationId}
      branchName={selectedWorkspaceBranch}
      targetBranch={selectedWorkspaceMergeTargetBranch}
      commitMessage={selectedWorkspaceCommitMessage}
      changes={gitChangesData}
      gitStatus={gitStatus}
      isGitStatusLoading={isGitStatusLoading}
      canRunGitOperations={canRunSelectedWorkspaceGitOperations}
      onOpenChanges={handleOpenWorkspaceChanges}
      onRefreshCommitMessage={refreshWorkspaces}
      onConflict={handleOpenResolveConflicts}
      className="mb-1.5"
    />
  ) : null

  // Early return for null task
  if (!task) {
    return <EmptyState />
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-background relative overflow-hidden">
      {/* Header */}
      <div className="px-6 py-3 flex items-center justify-between border-b border-border/60 bg-background z-20 flex-shrink-0">
        <div className="flex flex-col min-w-0 flex-1 mr-4">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className={`w-2 h-2 rounded-full shrink-0 ${task.projectColor.replace('text-', 'bg-')}`} />
            <span className="text-xs text-muted-foreground truncate">
              {task.projectName}
            </span>
            {task.projectArchivedAt && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0">
                {task.projectRepoDeletedAt ? t('源码已删除') : t('已删除')}
              </span>
            )}
            <span className="text-muted-foreground/40 text-xs">/</span>
            <span className="text-xs text-muted-foreground/70 font-mono truncate">{task.branch}</span>
          </div>
          <h2 className="text-lg font-semibold text-foreground break-words line-clamp-2">{task.title}</h2>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <StatusBadge
            status={task.status}
            onChangeStatus={!isProjectReadOnly && onTaskStatusChange ? (newStatus) => onTaskStatusChange(task.id, newStatus) : undefined}
          />

          <div className="flex items-center gap-1">
            {/* Open in IDE */}
            <button
              onClick={handleOpenInIde}
              disabled={!workingDir || isProjectReadOnly}
              className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title={t('Open in IDE')}
            >
              <Code2 size={16} />
            </button>

            {/* More Actions — 创建 TeamRun / 重新开始 / 删除任务 */}
            {(onDeleteTask || showCreateTeamRunEntry) && !isProjectReadOnly && (
              <div className="relative" ref={moreMenuRef}>
                <button
                  onClick={() => setIsMoreMenuOpen(v => !v)}
                  className="w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-muted transition-colors"
                  title={t('More actions')}
                >
                  <MoreVertical size={16} />
                </button>
                {isMoreMenuOpen && (
                  <div className="absolute right-0 top-full mt-2 w-44 bg-background rounded-lg border border-border shadow-lg z-50 py-1">
                    {showCreateTeamRunEntry && (
                      <button
                        onClick={() => {
                          setIsCreateTeamRunDialogOpen(true)
                          setIsMoreMenuOpen(false)
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground/80 hover:bg-muted/50 transition-colors"
                      >
                        <Plus size={15} />
                        <span>{t('创建 TeamRun')}</span>
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setIsRetryConfirmOpen(true)
                        setIsMoreMenuOpen(false)
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground/80 hover:bg-muted/50 transition-colors"
                    >
                      <RotateCcw size={15} />
                      <span>{t('重新开始')}</span>
                    </button>
                    {onDeleteTask && (
                      <>
                        <div className="my-1 border-t border-border/60" />
                        <button
                          onClick={() => {
                            setIsDeleteConfirmOpen(true)
                            setIsMoreMenuOpen(false)
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <Trash2 size={15} />
                          <span>{t('删除任务')}</span>
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Conflict Banner */}
      {canRunSelectedWorkspaceGitOperations && selectedWorkspaceOperationId && gitStatus && (
        <ConflictBanner
          workspaceId={selectedWorkspaceOperationId}
          gitStatus={gitStatus}
          onResolve={() => handleOpenResolveConflicts()}
        />
      )}

      {/* Main Area — two-column layout */}
      <div ref={mainAreaRef} className="flex-1 flex overflow-hidden">
        {/* Chat Panel (LogStream + Input) */}
        <div
          className="flex min-w-0 flex-1 flex-col bg-background relative"
        >
          {isTeamRunMode && teamRun ? (
            focusedInvocationSessionId ? (
              <>
                <div className="relative z-20 flex shrink-0 items-center justify-between gap-3 overflow-visible border-b border-border px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-foreground">{t('Invocation details')}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {focusedInvocationSessionId}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <SessionReadonlyMeta
                      session={displayedSession}
                      providers={providers}
                      usage={tokenUsage}
                      providerIdFallback={focusedInvocationMember?.providerId}
                      agentTypeFallback={displayedSession?.agentType}
                      tokenTooltipSide="bottom"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 rounded-lg border border-border/70 bg-background/60 px-2 text-xs font-medium text-muted-foreground hover:border-muted-foreground/40 hover:bg-muted hover:text-foreground"
                      onClick={handleBackToTeamRoom}
                    >
                      <ArrowLeft size={13} />
                      <span>{t('Team room')}</span>
                    </Button>
                  </div>
                </div>
                <div className="relative flex-1 min-h-0">
                  <div ref={scrollRef} className="h-full overflow-y-auto scrollbar-app-thin px-6 pt-6 pb-4">
                    <div ref={contentRef} className="w-full max-w-4xl mx-auto">
                      {isLoadingSnapshot ? (
                        <div className="flex items-center justify-center py-12 gap-3 text-muted-foreground/70">
                          <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          <span className="text-sm">{t('Loading logs...')}</span>
                        </div>
                      ) : logs.length === 0 ? (
                        <div className="text-muted-foreground/70 text-center py-8">
                          {isSessionActive ? t('Waiting for agent output...') : t('No logs recorded for this session.')}
                        </div>
                      ) : (
                        <LogStream logs={logs} />
                      )}
                    </div>
                  </div>

                  {!isAtBottom && (
                    <button
                      onClick={() => scrollToBottom()}
                      className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 bg-background/90 backdrop-blur-sm border border-border rounded-full shadow-md text-xs text-muted-foreground hover:bg-background hover:text-foreground transition-all"
                      aria-label={t('Scroll to bottom')}
                    >
                      <ArrowDown size={14} />
                      <span>{t('回到底部')}</span>
                    </button>
                  )}
                </div>
                {todos.length > 0 && (
                  <div className="px-6 pt-2 pb-1 bg-background flex-shrink-0 border-t border-border/60">
                    <div className="max-w-4xl mx-auto">
                      <TodoPanel todos={todos} />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <RoomTimeline
                teamRun={teamRun}
                messages={roomMessages ?? teamRun.messages ?? []}
                readOnly={isProjectReadOnly}
                readOnlyMessage={projectReadOnlyMessage}
                onSendMessage={handlePostRoomMessage}
                onViewInvocationSession={handleViewInvocationSession}
                changeSummaryBar={workspaceChangeSummaryBar}
                centered
              />
            )
          ) : (
            <>
          {/* Scrollable Logs */}
          <div className="relative flex-1 min-h-0">
            <div ref={scrollRef} className="h-full overflow-y-auto scrollbar-app-thin px-6 pt-6 pb-4">
            <div ref={contentRef} className="w-full min-w-0 max-w-4xl mx-auto">
              {/* Task Description */}
              {(isLoadingTaskBody || taskBody?.body) && (
                <div className="mb-4 pb-4 border-b border-border/60 min-w-0">
                  {isLoadingTaskBody ? (
                    <p className="text-sm text-muted-foreground/70 italic">{t('Loading...')}</p>
                  ) : taskBody?.body ? (
                    <div className="text-sm text-muted-foreground leading-relaxed prose prose-sm max-w-none break-words overflow-hidden">
                      <Streamdown urlTransform={attachmentUrlTransform} components={streamdownComponents}>
                        {taskBody.body}
                      </Streamdown>
                    </div>
                  ) : null}
                </div>
              )}

              {/* Setup Script Progress */}
              {setupProgress && (
                <div className="flex items-center justify-center gap-2 py-3 text-muted-foreground/70 text-sm">
                  {setupProgress.status === 'running' && (
                    <>
                      <svg className="animate-spin h-3.5 w-3.5 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      <span>{t('Setup ({current}/{total}): {command}', {
                        current: setupProgress.currentIndex,
                        total: setupProgress.totalCommands,
                        command: setupProgress.currentCommand,
                      })}</span>
                    </>
                  )}
                  {setupProgress.status === 'completed' && (
                    <span className="text-success">{t('Setup 完成')}</span>
                  )}
                  {setupProgress.status === 'failed' && (
                    <span className="text-destructive/80">{t('Setup 失败: {error}', { error: setupProgress.error })}</span>
                  )}
                </div>
              )}

              {!isProjectReadOnly && autoStartState && (isLoadingWorkspaces || sessionId) ? (
                <div className="flex justify-center py-3">
                  <AutoStartStatus
                    state={autoStartState}
                    onRetry={autoStartState.status === 'failed' ? handleOpenStartDialog : undefined}
                  />
                </div>
              ) : null}

              {isLoadingWorkspaces ? (
                <div className="flex items-center justify-center py-12 gap-3 text-muted-foreground/70">
                  <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="text-sm">{t('Loading...')}</span>
                </div>
              ) : sessionId ? (
                isLoadingSnapshot ? (
                  <div className="flex items-center justify-center py-12 gap-3 text-muted-foreground/70">
                    <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span className="text-sm">{t('Loading logs...')}</span>
                  </div>
                ) : logs.length === 0 ? (
                  <div className="text-muted-foreground/70 text-center py-8">
                    {isSessionActive ? t('Waiting for agent output...') : t('No logs recorded for this session.')}
                  </div>
                ) : (
                  <LogStream logs={logs} />
                )
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="w-14 h-14 bg-muted/50 rounded-2xl border border-border/60 flex items-center justify-center mb-5">
                    <Play size={24} className="text-muted-foreground/70 ml-0.5" />
                  </div>
                  <h3 className="text-base font-medium text-foreground mb-1.5">
                    {isProjectReadOnly ? t('项目为只读历史') : t('尚未启动 Agent')}
                  </h3>
                  <p className="text-sm text-muted-foreground mb-6 max-w-xs">
                    {isProjectReadOnly
                      ? projectReadOnlyMessage
                      : t('选择一个 Agent 来执行此任务，Agent 将自动创建工作空间并开始工作。')}
                  </p>
                  {!isProjectReadOnly && autoStartState ? (
                    <AutoStartStatus state={autoStartState} />
                  ) : null}
                  {!isProjectReadOnly && (
                    <div className="flex flex-wrap items-center justify-center gap-3">
                      <Button onClick={handleOpenStartDialog} disabled={Boolean(autoStartState && autoStartState.status !== 'failed')}>
                        <Play size={16} className="mr-1.5" />
                        {autoStartState?.status === 'failed' ? t('重试启动 Agent') : t('启动 Agent')}
                      </Button>
                      {showCreateTeamRunEntry && (
                        <Button variant="outline" onClick={() => setIsCreateTeamRunDialogOpen(true)}>
                          <Plus size={16} className="mr-1.5" />
                          {t('创建 TeamRun')}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

            {/* Scroll to bottom button */}
            {!isAtBottom && (
              <button
                onClick={() => scrollToBottom()}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 bg-background/90 backdrop-blur-sm border border-border rounded-full shadow-md text-xs text-muted-foreground hover:bg-background hover:text-foreground transition-all"
                aria-label={t('Scroll to bottom')}
              >
                <ArrowDown size={14} />
                <span>{t('回到底部')}</span>
              </button>
            )}
          </div>

          {/* Todo Panel — fixed between logs and input */}
          {todos.length > 0 && (
            <div className="px-6 pt-2 pb-1 bg-background flex-shrink-0 border-t border-border/60">
              <div className="max-w-4xl mx-auto">
                <TodoPanel todos={todos} />
              </div>
            </div>
          )}

          {/* Input Area */}
          {isProjectReadOnly ? (
            <div className="p-6 pt-3 bg-background flex-shrink-0 w-full z-10 pb-6 border-t border-border/60">
              <div className="max-w-4xl mx-auto">
                <div className="bg-muted/50 rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
                  {projectReadOnlyMessage}
                </div>
              </div>
            </div>
          ) : isReadOnlySession ? (
            <div className="p-6 pt-3 bg-background flex-shrink-0 w-full z-10 pb-6 border-t border-border/60">
              <div className="max-w-4xl mx-auto">
                <div className="flex items-center justify-between bg-muted/50 rounded-xl border border-border px-4 py-3">
                  <span className="text-sm text-muted-foreground">{t('代码已合并，以上为历史沟通记录')}</span>
                  <Button size="sm" onClick={handleOpenStartDialog}>
                    <Play size={14} className="mr-1.5" />
                    {t('启动新 Agent')}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
          <div
            className="p-6 pt-2 bg-background flex-shrink-0 w-full z-10 pb-6 border-t border-transparent"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="max-w-4xl mx-auto">
              {workspaceChangeSummaryBar}
              <div
                ref={inputContainerRef}
                className={`relative bg-background rounded-xl border hover:border-ring/40 focus-within:border-ring/60 transition-colors duration-200 ${
                isDragOver ? 'border-info bg-info/5' : 'border-border'
              }`}
              >
              {/* Attachment Preview */}
              <AttachmentPreview files={attachmentFiles} onRemove={removeFile} />

              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInput}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (skillMentionMenu.handleKeyDown(e)) return
                  if (slashCommandMenu.handleKeyDown(e)) return
                  if (e.key === 'Enter' && !e.shiftKey && !e.repeat && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                rows={1}
                placeholder={isDragOver ? t('Drop files here...') : sessionId && !isSessionActive ? t('Continue conversation...') : t('Message Agent...')}
                className="w-full px-4 pt-4 pb-2 bg-transparent border-none focus:outline-none resize-none text-sm text-foreground placeholder-muted-foreground/70 leading-relaxed"
                style={{ minHeight: '60px', maxHeight: '300px' }}
              />

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileInputChange}
              />

              {/* Toolbar Row */}
              <div className="flex items-center justify-between px-2 pb-2 pt-1">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="p-2 text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted rounded-lg transition-colors"
                    title={t('Upload file')}
                  >
                    <Paperclip size={18} />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {activeSession && providers && (
                    <ProviderSelector
                      providers={providers}
                      currentProviderId={selectedProviderId}
                      agentType={activeSession.agentType}
                      onSelect={setSelectedProviderId}
                    />
                  )}
                  <TokenUsageIndicator usage={tokenUsage} />
                  {isSessionActive && !input.trim() && !hasAttachments ? (
                    <button
                      onClick={handleStop}
                      disabled={stopSession.isPending}
                      className="p-2 rounded-lg transition-all duration-200 bg-destructive text-white hover:bg-destructive/90 disabled:opacity-50"
                    >
                      <Square size={14} />
                    </button>
                  ) : (
                    <button
                      onClick={handleSend}
                      disabled={(!input.trim() && !hasAttachments) || isUploading}
                      className={`p-2 rounded-lg transition-all duration-200 ${
                        (input.trim() || hasAttachments) && !isUploading
                          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                          : 'bg-transparent text-muted-foreground/50 cursor-not-allowed'
                      }`}
                    >
                      <ArrowUp size={18} />
                    </button>
                  )}
                </div>
              </div>
            </div>
            </div>
            <SlashCommandPopover
              open={slashCommandMenu.query !== null}
              anchorRef={inputContainerRef}
              commands={slashCommandMenu.filteredCommands}
              selectedIndex={slashCommandMenu.selectedIndex}
              query={slashCommandMenu.query ?? ''}
              hasCatalog={slashCommandMenu.allCommands.length > 0}
              onSelect={slashCommandMenu.applyCommand}
            />
            <SlashCommandPopover
              open={skillMentionMenu.query !== null}
              anchorRef={inputContainerRef}
              commands={skillMentionMenu.filteredSkills}
              selectedIndex={skillMentionMenu.selectedIndex}
              query={skillMentionMenu.query ?? ''}
              hasCatalog={skillMentionMenu.allSkills.length > 0}
              title="Skills"
              queryPrefix="$"
              emptyCatalogMessage="No skills catalog for this agent yet."
              onSelect={skillMentionMenu.applySkill}
            />
          </div>
          )}
            </>
          )}
        </div>

        {isWorkspaceOpen && (
          <div
            className="w-1 cursor-col-resize hover:bg-border active:bg-ring/40 transition-colors z-50 -ml-[2px] flex-shrink-0 h-full"
            onMouseDown={handleWorkspaceResizeStart}
            role="separator"
            aria-orientation="vertical"
            aria-label={t('调整工作区宽度')}
          />
        )}

        {/* Right: WorkspacePanel — rail is always visible, content expands on demand */}
        <div
          className="flex h-full flex-shrink-0 bg-background"
          style={{
            width: isWorkspaceOpen
              ? WORKSPACE_PANEL_RAIL_WIDTH + workspaceContentWidth
              : WORKSPACE_PANEL_RAIL_WIDTH,
          }}
        >
          <WorkspacePanel
            sessionId={sessionId || undefined}
            workspaceId={resolvedWorkspaceId}
            workingDir={workingDir}
            projectId={task.projectId}
            readOnly={isProjectReadOnly}
            repoDeleted={isProjectRepoDeleted}
            teamRun={teamRun}
            teamStatus={teamRun ? (
              <TeamStatusPanel
                teamRun={teamRun}
                workspaces={workspaces}
                selectedWorkspaceId={resolvedWorkspaceId}
                onSelectWorkspace={setExplicitWorkspaceId}
                onViewInvocationSession={handleViewInvocationSession}
              />
            ) : undefined}
            workspaces={workspaces}
            selectedWorkspaceId={resolvedWorkspaceId}
            onSelectWorkspace={setExplicitWorkspaceId}
            variant="rail"
            expanded={isWorkspaceOpen}
            onExpandedChange={(expanded) => {
              if (expanded) {
                setWorkspaceContentWidth((current) => clampWorkspaceContentWidth(current))
              }
              setIsWorkspaceOpen(expanded)
            }}
            minContentWidth={WORKSPACE_PANEL_MIN_WIDTH}
            tabRef={workspacePanelTabRef}
            gitProps={canRunSelectedWorkspaceGitOperations && selectedWorkspaceOperationId ? {
              branchName: selectedWorkspaceBranch,
              targetBranch: selectedWorkspaceMergeTargetBranch,
              commitMessage: selectedWorkspaceCommitMessage,
              canRunGitOperations: true,
              onRefreshCommitMessage: refreshWorkspaces,
              onConflict: handleOpenResolveConflicts,
              onResolveConflicts: () => handleOpenResolveConflicts(),
            } : undefined}
          />
        </div>

      </div>

      {/* Start Agent Dialog */}
      {!isProjectReadOnly && (
        <StartAgentDialog
          isOpen={isStartDialogOpen}
          onClose={() => setIsStartDialogOpen(false)}
          taskId={task.id}
          taskTitle={taskBody?.title ?? task.title}
          taskDescription={taskBody?.body ?? ''}
          taskPrompt={taskBody?.prompt}
          onStarted={() => onAutoStartRecovered?.(task.id)}
        />
      )}

      {/* Create TeamRun Dialog */}
      {showCreateTeamRunEntry && !isProjectReadOnly && (
        <CreateTeamRunDialog
          isOpen={isCreateTeamRunDialogOpen}
          onClose={() => setIsCreateTeamRunDialogOpen(false)}
          taskId={task.id}
        />
      )}

      {/* GitOperationsDialog removed — Git operations are now inline in Changes tab */}

      {/* Resolve Conflicts Dialog */}
      {canRunSelectedWorkspaceGitOperations && resolveConflictWorkspaceId && conflictDetails && (
        <ResolveConflictsDialog
          open={isResolveDialogOpen}
          onOpenChange={(open) => {
            setIsResolveDialogOpen(open)
            if (!open) setPendingConflictDetails(null)
          }}
          workspaceId={resolveConflictWorkspaceId}
          conflictOp={conflictDetails.conflictOp}
          conflictedFiles={conflictDetails.conflictedFiles}
          sourceBranch={resolveConflictSourceBranch}
          targetBranch={resolveConflictTargetBranch}
          operation={gitStatus?.operation}
          worktreePath={resolveConflictWorktreePath}
          mergeAborted={conflictDetails.mergeAborted}
          mergeStrategy={conflictDetails.mergeStrategy}
          sourceWorkspaceId={conflictDetails.sourceWorkspaceId}
          targetWorkspaceId={conflictDetails.targetWorkspaceId}
          sourceWorktreePath={conflictDetails.sourceWorktreePath}
          targetWorktreePath={conflictDetails.targetWorktreePath}
          sessions={selectedWorkspaceSessions}
          currentSessionId={isTeamRunMode ? undefined : sessionId}
          teamRunId={teamRun?.id}
        />
      )}

      {/* Retry Confirm Dialog */}
      <ConfirmDialog
        isOpen={isRetryConfirmOpen}
        onClose={() => setIsRetryConfirmOpen(false)}
        onConfirm={handleRetryTask}
        title={t('重新开始任务')}
        description={
          <p>{t('将归档当前工作区并自动在新 Worktree 中重新启动 Agent，旧工作区内容保留供参考。')}</p>
        }
        confirmText={t('确认重试')}
        variant="default"
        isLoading={isRetrying}
      />

      {/* Delete Confirm Dialog */}
      <DeleteTaskConfirmDialog
        isOpen={isDeleteConfirmOpen}
        onClose={() => setIsDeleteConfirmOpen(false)}
        onConfirm={handleDeleteTask}
        taskId={task.id}
        taskTitle={task.title}
        workspaces={workspaces}
        isLoading={isDeleting}
      />
    </div>
  )
}
