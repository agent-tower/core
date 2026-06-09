import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useQueryClient } from '@tanstack/react-query'
import { SessionStatus, WorkspaceStatus, type ConflictOp, type Session } from '@agent-tower/shared'
import { LogStream, TodoPanel, TokenUsageIndicator } from '@/components/agent'
import {
  ArrowLeft, ArrowUp, ArrowDown, Paperclip, Play, Square,
  MessageSquare, FolderOpen, GitGraph, Code2, Trash2, MoreVertical, History, Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RoomTimeline } from '@/components/team/RoomTimeline'
import { TeamStatusPanel } from '@/components/team/TeamStatusPanel'
import { WorkspacePanel } from '@/components/workspace/WorkspacePanel'
import { MobileChangesView } from './MobileChangesView'
import { MobileHistoryView } from './MobileHistoryView'
import { useTaskTeamRun, useRoomMessages, usePostRoomMessage } from '@/hooks/use-team-run'
import { useWorkspaces, useOpenInEditor } from '@/hooks/use-workspaces'
import { useNormalizedLogs } from '@/lib/socket/hooks/useNormalizedLogs'
import { useSendMessage, useStopSession } from '@/hooks/use-sessions'
import { useProviders } from '@/hooks/use-providers'
import { useTodos } from '@/hooks/use-todos'
import { useTokenUsage } from '@/hooks/useTokenUsage'
import { useAttachments } from '@/hooks/use-attachments'
import { AttachmentPreview } from '@/components/ui/AttachmentPreview'
import { StartAgentDialog } from '@/components/task/StartAgentDialog'
import { getSessionTokenUsage, SessionReadonlyMeta } from '@/components/task/SessionReadonlyMeta'
import { ProviderSelector } from '@/components/task/ProviderSelector'
import { SlashCommandPopover } from '@/components/task/SlashCommandPopover'
import { DeleteTaskConfirmDialog } from '@/components/task/DeleteTaskConfirmDialog'
import { WorkspaceSwitcher } from '@/components/workspace/WorkspaceSwitcher'
import {
  canRunWorkspaceGitOperations,
  getWorkspaceMergeTargetBranch,
  getWorkspaceWorkingDir,
  resolveDefaultWorkspaceId,
} from '@/components/workspace/team-workspace-view'
import { GitStatusBar } from '@/components/workspace/GitStatusBar'
import { ResolveConflictsDialog } from '@/components/workspace/ResolveConflictsDialog'
import type { ConflictDetails } from '@/components/workspace/GitOperationsDialog'
import { useGitStatus } from '@/hooks/use-workspaces'
import { useGitChanges } from '@/hooks/use-git'
import { queryKeys } from '@/hooks/query-keys'
import type { UITaskDetailData } from '@/components/task/types'
import { UITaskStatus } from '@/components/task/types'
import { useSlashCommandMenu } from '@/components/task/useSlashCommandMenu'
import { useSkillMentionMenu } from '@/components/task/useSkillMentionMenu'
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

interface MobileTaskDetailProps {
  task: UITaskDetailData
  onBack: () => void
  onDeleteTask?: (taskId: string) => void
  isDeleting?: boolean
}

type MobileTab = 'chat' | 'team-status' | 'changes' | 'history' | 'workspace'

// ============ Status Badge ============

function StatusDot({ status }: { status: UITaskStatus }) {
  const colors: Record<UITaskStatus, string> = {
    [UITaskStatus.Running]: 'bg-blue-500',
    [UITaskStatus.Review]: 'bg-amber-500',
    [UITaskStatus.Pending]: 'bg-neutral-400',
    [UITaskStatus.Done]: 'bg-emerald-500',
    [UITaskStatus.Cancelled]: 'bg-neutral-400',
  }
  return <span className={`w-2.5 h-2.5 rounded-full ${colors[status]}`} />
}

// ============ Tab Bar ============

const SOLO_TAB_CONFIG: { key: MobileTab; label: string; icon: typeof MessageSquare }[] = [
  { key: 'chat', label: 'Chat', icon: MessageSquare },
  { key: 'changes', label: 'Changes', icon: GitGraph },
  { key: 'history', label: 'History', icon: History },
  { key: 'workspace', label: 'Workspace', icon: FolderOpen },
]

const TEAM_RUN_TAB_CONFIG: { key: MobileTab; label: string; icon: typeof MessageSquare }[] = [
  { key: 'chat', label: 'Team room', icon: MessageSquare },
  { key: 'team-status', label: 'Team Status', icon: Users },
  { key: 'changes', label: 'Changes', icon: GitGraph },
  { key: 'workspace', label: 'Workspace', icon: FolderOpen },
]

// ============ Main Component ============

export function MobileTaskDetail({ task, onBack, onDeleteTask, isDeleting }: MobileTaskDetailProps) {
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState<MobileTab>('chat')
  const [input, setInput] = useState('')
  const [isStartDialogOpen, setIsStartDialogOpen] = useState(false)
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false)
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false)
  const [focusedInvocationSessionId, setFocusedInvocationSessionId] = useState<string | null>(null)
  const [explicitWorkspaceId, setExplicitWorkspaceId] = useState<string | undefined>(undefined)
  const inputContainerRef = useRef<HTMLDivElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    resize: 'smooth',
    initial: 'instant',
  })

  const queryClient = useQueryClient()

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

  // ============ Session Discovery ============

  const { data: workspaces, isLoading: isLoadingWorkspaces } = useWorkspaces(task.id)
  const { data: taskTeamRun } = useTaskTeamRun(task.id)
  const { data: roomMessages } = useRoomMessages(taskTeamRun?.id ?? '')
  const postRoomMessage = usePostRoomMessage(taskTeamRun?.id ?? '')
  const teamRun = taskTeamRun ?? null
  const tabConfig = teamRun ? TEAM_RUN_TAB_CONFIG : SOLO_TAB_CONFIG

  useEffect(() => {
    setExplicitWorkspaceId(undefined)
    setFocusedInvocationSessionId(null)
  }, [task.id])

  useEffect(() => {
    if (teamRun && activeTab === 'history') {
      setActiveTab('chat')
    }
    if (!teamRun && activeTab === 'team-status') {
      setActiveTab('chat')
    }
  }, [activeTab, teamRun])

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

  // ============ Working Dir (hoisted for git hooks) ============

  const workingDir = useMemo(() => {
    if (!workspaces) return undefined
    if (selectedWorkspace) return getWorkspaceWorkingDir(selectedWorkspace)
    for (const ws of workspaces) {
      if (ws.status === 'ACTIVE' && getWorkspaceWorkingDir(ws)) return getWorkspaceWorkingDir(ws)
    }
    return getWorkspaceWorkingDir(workspaces[0])
  }, [selectedWorkspace, workspaces])

  // ============ Git Operation State ============

  const selectedWorkspaceOperationId = selectedWorkspace?.status === WorkspaceStatus.ACTIVE
    ? selectedWorkspace.id
    : undefined
  const canRunGit = canRunWorkspaceGitOperations(selectedWorkspace, teamRun)
  const selectedWorkspaceBranch = selectedWorkspace?.branchName ?? ''
  const selectedWorkspaceCommitMessage = selectedWorkspace?.commitMessage
  const selectedWorkspaceMergeTargetBranch = useMemo(
    () => getWorkspaceMergeTargetBranch(selectedWorkspace, workspaces, task?.mainBranch ?? ''),
    [selectedWorkspace, task?.mainBranch, workspaces],
  )
  const { data: gitStatus } = useGitStatus(selectedWorkspaceOperationId ?? '')
  const { data: gitChangesData } = useGitChanges(workingDir)
  const committedFileCount = gitChangesData?.committed?.length
  const [isResolveDialogOpen, setIsResolveDialogOpen] = useState(false)
  const [pendingConflictDetails, setPendingConflictDetails] = useState<ConflictDetails | null>(null)

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
  const selectedWorkspaceSessions = selectedWorkspace?.sessions ?? []

  const handleOpenResolveConflicts = useCallback((details?: ConflictDetails) => {
    setPendingConflictDetails(details ?? null)
    setIsResolveDialogOpen(true)
  }, [])

  const refreshWorkspaces = useCallback(() => {
    if (!task?.id) return Promise.resolve()
    return queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(task.id) })
  }, [task?.id, queryClient])

  const activeSession = useMemo(() => {
    if (!workspaces) return null
    const allSessions: Session[] = workspaces
      .filter((ws) => ws.status === 'ACTIVE' && Array.isArray(ws.sessions))
      .flatMap((ws) => ws.sessions ?? [])

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

    const pickLatest = (statuses: SessionStatus[]): Session | null => {
      const candidates = allSessions.filter((s) => statuses.includes(s.status))
      if (candidates.length === 0) return null
      return candidates.sort((a, b) => getSessionTime(b) - getSessionTime(a))[0] ?? null
    }

    const activeResult = (
      pickLatest([SessionStatus.RUNNING]) ??
      pickLatest([SessionStatus.PENDING]) ??
      pickLatest([SessionStatus.COMPLETED, SessionStatus.FAILED, SessionStatus.CANCELLED])
    )

    if (activeResult) return activeResult

    const historySessions: Session[] = workspaces
      .filter((ws) => (ws.status === 'ABANDONED' || ws.status === 'MERGED' || ws.status === 'HIBERNATED') && Array.isArray(ws.sessions))
      .flatMap((ws) => ws.sessions ?? [])

    const historyCandidates = historySessions.filter((session) =>
      [SessionStatus.COMPLETED, SessionStatus.FAILED, SessionStatus.CANCELLED].includes(session.status)
    )
    if (historyCandidates.length === 0) return null
    return historyCandidates.sort((a, b) => getSessionTime(b) - getSessionTime(a))[0] ?? null
  }, [workspaces])

  const sessionId = activeSession?.id ?? ''
  const logSessionId = teamRun ? focusedInvocationSessionId ?? '' : sessionId
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
  const isProjectReadOnly = Boolean(task.projectArchivedAt)
  const isProjectRepoDeleted = Boolean(task.projectRepoDeletedAt)
  const projectReadOnlyMessage = isProjectRepoDeleted
    ? t('项目已删除，本地仓库文件也已清理。恢复项目并重新绑定仓库后才能继续操作。')
    : t('项目已删除。恢复项目后才能继续创建会话或修改任务。')
  const isReadOnlySession = useMemo(() => {
    if (!activeSession || !workspaces) return false
    const hasActiveWorkspace = workspaces.some((workspace) =>
      workspace.status === 'ACTIVE' && workspace.sessions?.some((session) => session.id === activeSession.id)
    )
    return !hasActiveWorkspace
  }, [activeSession, workspaces])

  // ============ Provider Info ============

  const { data: providers } = useProviders()
  const [selectedProviderOverride, setSelectedProviderOverride] = useState<{ sessionId: string; providerId: string | null } | null>(null)
  const selectedProviderId = selectedProviderOverride?.sessionId === sessionId
    ? selectedProviderOverride.providerId
    : activeSession?.providerId ?? null
  const handleSelectProvider = useCallback((providerId: string | null) => {
    setSelectedProviderOverride({ sessionId, providerId })
  }, [sessionId])

  const slashCommandMenu = useSlashCommandMenu({
    agentType: activeSession?.agentType,
    workingDir,
    input,
    setInput,
    textareaRef,
    minHeight: 40,
    maxHeight: 140,
  })

  const skillMentionMenu = useSkillMentionMenu({
    agentType: activeSession?.agentType,
    workingDir,
    input,
    setInput,
    textareaRef,
    minHeight: 40,
    maxHeight: 140,
  })

  const selectedWorkspaceOpenId = workingDir && selectedWorkspace ? selectedWorkspace.id : undefined


  // ============ Mutations ============

  const sendMessageMutation = useSendMessage()
  const openInEditorMutation = useOpenInEditor()
  const stopSession = useStopSession()

  // ============ Log Stream ============

  const { isConnected, isLoadingSnapshot, logs, entries, attach } = useNormalizedLogs({
    sessionId: logSessionId,
    sessionStatus: displayedSession?.status,
    onExit: useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
    }, [queryClient]),
  })

  const { todos } = useTodos(entries)

  const { files: attachmentFiles, addFiles, removeFile, clear: clearAttachments, buildMarkdownLinks, hasFiles: hasAttachments, isUploading } = useAttachments()

  // Token usage — 取最新一条，回退到持久化值
  const initialTokenUsage = useMemo(() => {
    return getSessionTokenUsage(displayedSession)
  }, [displayedSession?.tokenUsage])
  const tokenUsage = useTokenUsage(logs, initialTokenUsage)

  useEffect(() => {
    if (logSessionId && isConnected) attach()
  }, [logSessionId, isConnected, attach])

  // Note: no explicit detach effect needed here.
  // useNormalizedLogs' internal cleanup already sends UNSUBSCRIBE for the
  // old sessionId when sessionId changes.

  // Snap to bottom instantly when switching tasks (no smooth animation)
  const prevTaskIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (prevTaskIdRef.current !== task.id && scrollRef.current) {
      const el = scrollRef.current
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
    }
    prevTaskIdRef.current = task.id
  }, [task.id, scrollRef])

  // ============ Actions ============

  const sendingRef = useRef(false)
  const handleSend = useCallback(async () => {
    if ((!input.trim() && !hasAttachments) || !sessionId || sendingRef.current || isUploading) return
    sendingRef.current = true

    const attachmentLinks = buildMarkdownLinks()
    const message = [input.trim(), attachmentLinks].filter(Boolean).join('\n\n')

    setInput('')
    clearAttachments()
    if (textareaRef.current) textareaRef.current.style.height = '40px'

    sendMessageMutation.mutate(
      { id: sessionId, message, providerId: selectedProviderId ?? undefined },
      {
        onSuccess: () => attach(),
        onSettled: () => { sendingRef.current = false },
      }
    )
  }, [input, sessionId, sendMessageMutation, attach, hasAttachments, isUploading, buildMarkdownLinks, clearAttachments, selectedProviderId])

  const handleStop = useCallback(async () => {
    if (!sessionId) return
    await stopSession.mutateAsync(sessionId)
    queryClient.invalidateQueries({ queryKey: ['workspaces'] })
  }, [sessionId, stopSession, queryClient])

  const handlePostRoomMessage = useCallback(
    (messageInput: Parameters<typeof postRoomMessage.mutateAsync>[0]) => postRoomMessage.mutateAsync(messageInput),
    [postRoomMessage],
  )

  const handleViewInvocationSession = useCallback((invocationSessionId: string) => {
    setFocusedInvocationSessionId(invocationSessionId)
    setActiveTab('chat')
    requestAnimationFrame(() => {
      scrollToBottom()
    })
  }, [scrollToBottom])

  const handleBackToTeamRoom = useCallback(() => {
    setFocusedInvocationSessionId(null)
  }, [])

  // ============ File Upload Handlers ============

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (fileList && fileList.length > 0) {
      addFiles(Array.from(fileList))
    }
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

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.max(40, Math.min(el.scrollHeight, 140))}px`
  }, [])

  const handleOpenInIde = useCallback(() => {
    if (!selectedWorkspaceOpenId) return
    openInEditorMutation.mutate({ workspaceId: selectedWorkspaceOpenId })
  }, [openInEditorMutation, selectedWorkspaceOpenId])

  // ============ Visual Viewport (iOS keyboard fix) ============
  // iOS Safari doesn't shrink dvh when the virtual keyboard opens.
  // Instead it scrolls the page up, leaving blank space below.
  // We use position:fixed and pin the container to the actual visible area
  // using visualViewport's height + offsetTop.
  //
  // IMPORTANT: only reposition on `resize` (keyboard open/close) unconditionally.
  // `scroll` events are suppressed while the user is actively touching, because
  // iOS fires viewport scroll during normal content scrolling, which causes the
  // container to jump in the opposite direction ("reverse scrolling").
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    let isTouching = false

    const applyViewport = () => {
      if (!containerRef.current) return
      containerRef.current.style.height = `${vv.height}px`
      containerRef.current.style.top = `${vv.offsetTop}px`
    }

    const onResize = () => applyViewport()
    const onScroll = () => { if (!isTouching) applyViewport() }
    const onTouchStart = () => { isTouching = true }
    const onTouchEnd = () => {
      isTouching = false
      requestAnimationFrame(applyViewport)
    }

    vv.addEventListener('resize', onResize)
    vv.addEventListener('scroll', onScroll)
    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchend', onTouchEnd, { passive: true })
    document.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      vv.removeEventListener('resize', onResize)
      vv.removeEventListener('scroll', onScroll)
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchend', onTouchEnd)
      document.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [])

  // ============ Prevent touch-induced viewport scrolling ============
  // Block touchmove on areas that have no scrollable container, so the
  // gesture doesn't leak to the layout viewport.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleTouchMove = (e: TouchEvent) => {
      let target = e.target as HTMLElement | null
      while (target && target !== container) {
        // Allow textarea scrolling only when content overflows
        if (target.tagName === 'TEXTAREA') {
          if (target.scrollHeight > target.clientHeight) return
          target = target.parentElement
          continue
        }
        const style = window.getComputedStyle(target)
        const oy = style.overflowY
        if ((oy === 'auto' || oy === 'scroll') && target.scrollHeight > target.clientHeight) {
          return
        }
        target = target.parentElement
      }
      e.preventDefault()
    }

    container.addEventListener('touchmove', handleTouchMove, { passive: false })
    return () => container.removeEventListener('touchmove', handleTouchMove)
  }, [])

  // ============ Render ============

  return (
    <div ref={containerRef} className="fixed inset-x-0 top-0 flex flex-col h-dvh bg-white overflow-hidden overscroll-none">
      {/* Header */}
      <header className="shrink-0 bg-white border-b border-neutral-200 z-20">
        <div className="flex items-center h-11 px-2.5 gap-1.5">
          <button onClick={onBack} className="p-1.5 -ml-0.5 text-neutral-600 active:text-neutral-900">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-[13px] font-bold text-neutral-900 truncate leading-tight">{task.title}</h1>
            <div className="flex min-w-0 items-center gap-1 text-[11px] text-neutral-500 leading-tight">
              <span className={`truncate font-medium ${task.projectColor}`}>{task.projectName}</span>
              {task.projectArchivedAt && (
                <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">
                  {task.projectRepoDeletedAt ? t('源码已删除') : t('已删除')}
                </span>
              )}
              <span className="text-neutral-300">/</span>
              <span className="font-mono truncate">{task.branch}</span>
            </div>
          </div>
          <StatusDot status={task.status} />
          <button
            onClick={handleOpenInIde}
            disabled={!selectedWorkspaceOpenId || isProjectReadOnly}
            className="p-1.5 text-neutral-400 active:text-neutral-900 disabled:opacity-30"
          >
            <Code2 size={16} />
          </button>
          {onDeleteTask && !isProjectReadOnly && (
            <div className="relative" ref={moreMenuRef}>
              <button
                onClick={() => setIsMoreMenuOpen(v => !v)}
                className="p-1.5 text-neutral-400 active:text-neutral-900"
                aria-label="More actions"
              >
                <MoreVertical size={16} />
              </button>
              {isMoreMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-40 bg-white rounded-lg border border-neutral-200 shadow-lg z-50 py-1">
                  <button
                    onClick={() => {
                      setIsDeleteConfirmOpen(true)
                      setIsMoreMenuOpen(false)
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 active:bg-red-50"
                  >
                    <Trash2 size={15} />
                    <span>{t('删除任务')}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sub-Tab Bar */}
        <div className="flex border-t border-neutral-100">
          {tabConfig.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex min-w-0 flex-1 items-center justify-center gap-1 px-1 py-2 text-[11px] font-medium transition-colors ${
                activeTab === key
                  ? 'text-neutral-900 border-b-2 border-neutral-900'
                  : 'text-neutral-400 border-b-2 border-transparent'
              }`}
            >
              <Icon size={13} className="shrink-0" />
              <span className="truncate">{t(label)}</span>
            </button>
          ))}
        </div>
      </header>

      {/* Content Area */}
      {activeTab === 'chat' && (
        teamRun ? (
          <main className="flex-1 min-h-0 overflow-hidden">
            {focusedInvocationSessionId ? (
              <div className="flex h-full min-h-0 flex-col bg-white">
                <div className="relative z-20 flex shrink-0 items-center justify-between gap-3 overflow-visible border-b border-neutral-200 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-neutral-900">{t('Invocation details')}</div>
                    <div className="truncate text-[11px] text-neutral-500">
                      {focusedInvocationSessionId}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <SessionReadonlyMeta
                      session={displayedSession}
                      providers={providers}
                      usage={tokenUsage}
                      compact
                      providerIdFallback={focusedInvocationMember?.providerId}
                      agentTypeFallback={displayedSession?.agentType}
                      tokenTooltipSide="bottom"
                    />
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="h-7 gap-1 rounded-lg border border-neutral-200/70 bg-white/60 px-1.5 text-[11px] font-medium text-neutral-500 hover:border-neutral-300 hover:bg-neutral-100 hover:text-neutral-900 active:bg-neutral-100"
                      onClick={handleBackToTeamRoom}
                    >
                      <ArrowLeft size={12} />
                      <span>{t('Team room')}</span>
                    </Button>
                  </div>
                </div>

                <div className="relative flex-1 min-h-0">
                  <div ref={scrollRef} className="h-full overflow-y-auto overflow-x-hidden scrollbar-app-thin overscroll-y-contain px-3 pt-3 pb-2">
                    <div ref={contentRef}>
                      {isLoadingSnapshot ? (
                        <LoadingSpinner label={t('Loading logs...')} />
                      ) : logs.length === 0 ? (
                        <div className="text-neutral-400 text-center py-8 text-sm">
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
                      className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-2.5 py-1 bg-white/90 backdrop-blur-sm border border-neutral-200 rounded-full shadow-md text-[11px] text-neutral-600 active:bg-white transition-all"
                      aria-label={t('Scroll to bottom')}
                    >
                      <ArrowDown size={12} />
                      <span>{t('回到底部')}</span>
                    </button>
                  )}
                </div>
                {todos.length > 0 && (
                  <div className="px-3 pt-1.5 pb-0.5 bg-white shrink-0 border-t border-neutral-100">
                    <TodoPanel todos={todos} compact />
                  </div>
                )}
              </div>
            ) : (
              <RoomTimeline
                teamRun={teamRun}
                messages={roomMessages ?? teamRun.messages ?? []}
                readOnly={isProjectReadOnly}
                readOnlyMessage={projectReadOnlyMessage}
                onSendMessage={handlePostRoomMessage}
                onViewInvocationSession={handleViewInvocationSession}
                compactComposer
              />
            )}
          </main>
        ) : (
          <div className="flex-1 flex flex-col min-h-0">
          {/* Scrollable Logs */}
          <div className="relative flex-1 min-h-0">
            <div ref={scrollRef} className="h-full overflow-y-auto overflow-x-hidden scrollbar-app-thin overscroll-y-contain px-3 pt-3 pb-2">
            <div ref={contentRef}>
            {/* Task Description */}
            <div className="mb-3 pb-2 border-b border-neutral-100">
              {task.description ? (
                <div className="text-[13px] text-neutral-500 leading-relaxed prose prose-sm max-w-none">
                  <Streamdown urlTransform={attachmentUrlTransform} components={streamdownComponents}>
                    {task.description}
                  </Streamdown>
                </div>
              ) : (
                <p className="text-[13px] text-neutral-400 italic">No description</p>
              )}
            </div>

            {isLoadingWorkspaces ? (
              <LoadingSpinner label="Loading..." />
            ) : sessionId ? (
              isLoadingSnapshot ? (
                <LoadingSpinner label="Loading logs..." />
              ) : logs.length === 0 ? (
                <div className="text-neutral-400 text-center py-8 text-sm">
                  {isSessionActive ? 'Waiting for agent output...' : 'No logs recorded.'}
                </div>
              ) : (
                <LogStream logs={logs} />
              )
            ) : (
              /* No session — show start agent CTA */
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-12 h-12 bg-neutral-50 rounded-xl border border-neutral-100 flex items-center justify-center mb-4">
                  <Play size={20} className="text-neutral-400 ml-0.5" />
                </div>
                <h3 className="text-sm font-medium text-neutral-900 mb-1">{t('尚未启动 Agent')}</h3>
                <p className="text-xs text-neutral-500 mb-5 max-w-[240px]">
                  {isProjectReadOnly ? projectReadOnlyMessage : t('选择一个 Agent 来执行此任务')}
                </p>
                {!isProjectReadOnly && (
                  <Button onClick={() => setIsStartDialogOpen(true)}>
                    <Play size={16} className="mr-1.5" />
                    {t('启动 Agent')}
                  </Button>
                )}
              </div>
            )}
            </div>
          </div>

            {/* Scroll to bottom button */}
            {!isAtBottom && (
              <button
                onClick={() => scrollToBottom()}
                className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-2.5 py-1 bg-white/90 backdrop-blur-sm border border-neutral-200 rounded-full shadow-md text-[11px] text-neutral-600 active:bg-white transition-all"
                aria-label="Scroll to bottom"
              >
                <ArrowDown size={12} />
                <span>{t('回到底部')}</span>
              </button>
            )}
          </div>

          {/* Todo Panel */}
          {todos.length > 0 && (
            <div className="px-3 pt-1.5 pb-0.5 bg-white shrink-0 border-t border-neutral-100">
              <TodoPanel todos={todos} compact />
            </div>
          )}

          {/* Input Area */}
          {isProjectReadOnly ? (
            <div className="px-3 py-2 bg-white shrink-0 border-t border-neutral-100">
              <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
                {projectReadOnlyMessage}
              </div>
            </div>
          ) : isReadOnlySession ? (
            <div className="px-3 py-2 bg-white shrink-0 border-t border-neutral-100">
              <div className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2">
                <span className="text-xs text-neutral-500">{t('代码已合并，以上为历史沟通记录')}</span>
                <Button size="sm" onClick={() => setIsStartDialogOpen(true)}>
                  <Play size={14} className="mr-1.5" />
                  {t('启动新 Agent')}
                </Button>
              </div>
            </div>
          ) : sessionId && (
            <div className="px-3 py-2 bg-white shrink-0 border-t border-neutral-100">
              <div
                ref={inputContainerRef}
                className="relative bg-white rounded-xl border border-neutral-200 shadow-sm focus-within:border-neutral-300"
              >
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
                  placeholder={!isSessionActive ? 'Continue conversation...' : 'Message Agent...'}
                  className="w-full px-3 pt-2.5 pb-1 bg-transparent border-none focus:outline-none resize-none text-[15px] text-neutral-900 placeholder-neutral-400"
                  style={{ minHeight: 40, maxHeight: 140 }}
                />

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileInputChange}
                />

                <div className="flex items-center justify-between px-2 pb-1.5">
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="p-1 text-neutral-400 active:text-neutral-600 rounded-lg"
                    >
                      <Paperclip size={15} />
                    </button>
                  </div>
                  <div className="flex items-center gap-1">
                    {activeSession && providers && (
                      <ProviderSelector
                        providers={providers}
                        currentProviderId={selectedProviderId}
                        agentType={activeSession.agentType}
                        onSelect={handleSelectProvider}
                      />
                    )}
                    <TokenUsageIndicator usage={tokenUsage} />
                    {isSessionActive && !input.trim() && !hasAttachments ? (
                      <button
                        onClick={handleStop}
                        disabled={stopSession.isPending}
                        className="p-1.5 rounded-lg bg-red-500 text-white active:bg-red-600 disabled:opacity-50"
                      >
                        <Square size={12} />
                      </button>
                    ) : (
                      <button
                        onClick={handleSend}
                        disabled={(!input.trim() && !hasAttachments) || isUploading}
                        className={`p-1.5 rounded-lg transition-colors ${
                          (input.trim() || hasAttachments) && !isUploading
                            ? 'bg-neutral-900 text-white active:bg-black'
                            : 'bg-transparent text-neutral-300'
                        }`}
                      >
                        <ArrowUp size={15} />
                      </button>
                    )}
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
                compact
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
                compact
                onSelect={skillMentionMenu.applySkill}
              />
            </div>
          )}
        </div>
        )
      )}

      {activeTab === 'team-status' && teamRun && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <TeamStatusPanel
            teamRun={teamRun}
            workspaces={workspaces}
            selectedWorkspaceId={resolvedWorkspaceId}
            onSelectWorkspace={setExplicitWorkspaceId}
            onViewInvocationSession={handleViewInvocationSession}
          />
        </div>
      )}

      {activeTab === 'changes' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {workspaces && workspaces.length > 1 && (
            <div className="shrink-0 border-b border-neutral-100 bg-white px-3 py-2">
              <WorkspaceSwitcher
                workspaces={workspaces}
                teamRun={teamRun}
                selectedWorkspaceId={resolvedWorkspaceId}
                onSelectWorkspace={setExplicitWorkspaceId}
                className="w-full"
                buttonClassName="w-full max-w-none min-w-0 justify-start"
              />
            </div>
          )}
          {canRunGit && selectedWorkspaceOperationId && (
            <div className="shrink-0">
              <GitStatusBar
                workspaceId={selectedWorkspaceOperationId}
                branchName={selectedWorkspaceBranch}
                targetBranch={selectedWorkspaceMergeTargetBranch}
                commitMessage={selectedWorkspaceCommitMessage}
                committedFileCount={committedFileCount}
                onRefreshCommitMessage={refreshWorkspaces}
                onConflict={handleOpenResolveConflicts}
                onResolveConflicts={() => handleOpenResolveConflicts()}
              />
            </div>
          )}
          <MobileChangesView workingDir={workingDir} />
        </div>
      )}

      {activeTab === 'history' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <MobileHistoryView workingDir={workingDir} />
        </div>
      )}

      {activeTab === 'workspace' && (
        <div className="flex-1 overflow-hidden">
          <WorkspacePanel
            sessionId={sessionId || undefined}
            workspaceId={resolvedWorkspaceId}
            workingDir={workingDir}
            projectId={task.projectId}
            className="h-full"
            hideChanges
            readOnly={isProjectReadOnly}
            repoDeleted={isProjectRepoDeleted}
          />
        </div>
      )}

      {/* Start Agent Dialog */}
      {!isProjectReadOnly && (
        <StartAgentDialog
          isOpen={isStartDialogOpen}
          onClose={() => setIsStartDialogOpen(false)}
          taskId={task.id}
          taskTitle={task.title}
          taskDescription={task.description}
        />
      )}

      {/* Delete Confirm Dialog */}
      <DeleteTaskConfirmDialog
        isOpen={isDeleteConfirmOpen}
        onClose={() => setIsDeleteConfirmOpen(false)}
        onConfirm={() => {
          onDeleteTask?.(task.id)
          setIsDeleteConfirmOpen(false)
        }}
        taskId={task.id}
        taskTitle={task.title}
        workspaces={workspaces}
        isLoading={isDeleting}
      />

      {/* Resolve Conflicts Dialog */}
      {isResolveDialogOpen && conflictDetails && resolveConflictWorkspaceId && (
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
          currentSessionId={teamRun ? undefined : sessionId}
          teamRunId={teamRun?.id}
        />
      )}
    </div>
  )
}

// ============ Helpers ============

function LoadingSpinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-12 gap-3 text-neutral-400">
      <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <span className="text-sm">{label}</span>
    </div>
  )
}
