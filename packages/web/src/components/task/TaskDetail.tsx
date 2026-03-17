import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useQueryClient } from '@tanstack/react-query'
import { SessionStatus, type Session } from '@agent-tower/shared'
import type { ConflictOp } from '@agent-tower/shared'
import { ServerEvents, ClientEvents, type SessionCompletedPayload, type TaskUpdatedPayload } from '@agent-tower/shared/socket'
import { LogStream } from '@/components/agent'
import { TodoPanel } from '@/components/agent'
import { TokenUsageIndicator } from '@/components/agent'
import { IconRunning, IconReview, IconPending, IconDone, IconCancelled } from '@/components/agent'
import { Paperclip, ArrowUp, ArrowDown, PanelRightClose, PanelRightOpen, Play, Square, Code2, Trash2, MoreVertical, GitFork, Cpu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { WorkspacePanel } from '@/components/workspace/WorkspacePanel'
import { useWorkspaces, useOpenInEditor, useGitStatus } from '@/hooks/use-workspaces'
import { useNormalizedLogs } from '@/lib/socket/hooks/useNormalizedLogs'
import { useWorkspaceSetupProgress } from '@/lib/socket/hooks/useWorkspaceSetupProgress'
import { socketManager } from '@/lib/socket/manager'
import { useSendMessage, useStopSession } from '@/hooks/use-sessions'
import { useProviders } from '@/hooks/use-providers'
import { useTodos } from '@/hooks/use-todos'
import { useTokenUsage } from '@/hooks/useTokenUsage'
import { useAttachments } from '@/hooks/use-attachments'
import { AttachmentPreview } from '@/components/ui/AttachmentPreview'
import { StartAgentDialog } from './StartAgentDialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ConflictBanner } from '@/components/workspace/ConflictBanner'
import { ResolveConflictsDialog } from '@/components/workspace/ResolveConflictsDialog'
import { GitOperationsDialog } from '@/components/workspace/GitOperationsDialog'
import type { UITaskDetailData } from './types'
import { UITaskStatus } from './types'
import { Streamdown } from 'streamdown'
import type { UrlTransform } from 'streamdown'
import { isTunnelAccess, getTunnelToken } from '@/lib/tunnel-token'
import 'streamdown/styles.css'

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

/** 给 URL 追加隧道 token（如果处于隧道模式） */
function withToken(url: string): string {
  if (!isTunnelAccess()) return url
  const token = getTunnelToken()
  if (!token) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(token)}`
}

/**
 * 将磁盘绝对路径转换为 HTTP URL，使浏览器能显示附件图片。
 */
const attachmentUrlTransform: UrlTransform = (url) => {
  if (url.includes('://')) return url
  if (url.startsWith('/api/')) return url
  if (url.startsWith('/')) {
    return withToken(`${API_BASE_URL}/attachments/by-path?path=${encodeURIComponent(url)}`)
  }
  return url
}

/** 自定义 img 渲染：限制图片尺寸，点击可查看原图 */
const MarkdownImage = ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
  <a href={src} target="_blank" rel="noopener noreferrer" className="inline-block">
    <img
      src={src}
      alt={alt}
      {...props}
      className="max-w-[300px] max-h-[200px] object-contain rounded-lg border border-neutral-200 cursor-pointer hover:opacity-90 transition-opacity"
    />
  </a>
)

const streamdownComponents = { img: MarkdownImage }

interface TaskDetailProps {
  task: UITaskDetailData | null
  /** 删除任务回调 — 传入 taskId */
  onDeleteTask?: (taskId: string) => void
  /** 删除中状态 */
  isDeleting?: boolean
  /** 状态变更回调 */
  onTaskStatusChange?: (taskId: string, newStatus: UITaskStatus) => void
}

// ============ Layout Constants ============

const CHAT_WIDTH_DEFAULT = 675
const CHAT_WIDTH_MIN = 320
const CHAT_WIDTH_MAX = 1200

// ============ Empty State (hoisted JSX) ============

const EMPTY_STATE = (
  <div className="flex-1 flex flex-col items-center justify-center bg-white text-neutral-400 select-none">
    <div className="w-16 h-16 bg-neutral-50 rounded-2xl border border-neutral-100 flex items-center justify-center mb-6">
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="text-neutral-300"
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
    <h3 className="text-neutral-900 font-medium mb-2 text-lg">Agent Tower</h3>
    <p className="text-sm max-w-sm text-center text-neutral-500 leading-relaxed">
      Select a task from the sidebar to view logs, monitor execution, or interact with an agent.
    </p>
  </div>
)

// ============ Status Badge Helper ============

const STATUS_OPTIONS = [
  { status: UITaskStatus.Review, className: 'bg-amber-50 text-amber-700 border-amber-100', hoverClass: 'hover:bg-amber-100', icon: <IconReview className="w-3 h-3" /> },
  { status: UITaskStatus.Running, className: 'bg-blue-50 text-blue-700 border-blue-100', hoverClass: 'hover:bg-blue-100', icon: <IconRunning className="w-3 h-3" /> },
  { status: UITaskStatus.Pending, className: 'bg-neutral-50 text-neutral-600 border-neutral-100', hoverClass: 'hover:bg-neutral-100', icon: <IconPending className="w-3 h-3" /> },
  { status: UITaskStatus.Done, className: 'bg-emerald-50 text-emerald-700 border-emerald-100', hoverClass: 'hover:bg-emerald-100', icon: <IconDone className="w-3 h-3" /> },
  { status: UITaskStatus.Cancelled, className: 'bg-neutral-50 text-neutral-500 border-neutral-200', hoverClass: 'hover:bg-neutral-200', icon: <IconCancelled className="w-3 h-3" /> },
] as const

function StatusBadge({ status, onChangeStatus }: { status: UITaskStatus; onChangeStatus?: (newStatus: UITaskStatus) => void }) {
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
        className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${current.className} ${onChangeStatus ? 'cursor-pointer hover:opacity-80' : ''}`}
      >
        {current.icon}
        <span>{status}</span>
        {onChangeStatus && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className={`ml-0.5 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
            <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-40 bg-white rounded-lg border border-neutral-200 shadow-lg z-50 py-1 animate-in fade-in zoom-in-95 duration-100">
          {STATUS_OPTIONS.filter(o => o.status !== status).map(opt => (
            <button
              key={opt.status}
              onClick={() => { onChangeStatus?.(opt.status); setIsOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium transition-colors ${opt.hoverClass}`}
            >
              <span className={opt.className.split(' ').find(c => c.startsWith('text-'))}>{opt.icon}</span>
              <span className="text-neutral-700">{opt.status}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ============ TaskDetail Component ============

export function TaskDetail({ task, onDeleteTask, isDeleting, onTaskStatusChange }: TaskDetailProps) {
  const [input, setInput] = useState('')
  const [isStartDialogOpen, setIsStartDialogOpen] = useState(false)
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false)
  const [isResolveDialogOpen, setIsResolveDialogOpen] = useState(false)
  const [isGitDialogOpen, setIsGitDialogOpen] = useState(false)
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    resize: 'smooth',
    initial: 'instant',
  })

  // Layout state
  const [chatWidth, setChatWidth] = useState(CHAT_WIDTH_DEFAULT)
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState(true)
  const [isResizing, setIsResizing] = useState(false)

  // Transient refs for resize — avoid re-renders during drag (rerender-use-ref-transient-values)
  const startXRef = useRef<number>(0)
  const startWidthRef = useRef<number>(0)
  const chatPanelRef = useRef<HTMLDivElement>(null)

  // ============ Session Discovery ============

  const { data: workspaces, isLoading: isLoadingWorkspaces } = useWorkspaces(task?.id ?? '')
  const setupProgress = useWorkspaceSetupProgress(task?.id)

  // Find the latest relevant session from workspaces.
  // We prioritize RUNNING > PENDING > terminal states, and within each bucket
  // pick the newest by available timestamps to avoid selecting stale sessions.
  // When no ACTIVE workspace has sessions, fall back to MERGED workspace sessions
  // so that communication history remains visible after merging code.
  const activeSession = useMemo(() => {
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

    // Fallback: show the latest session from MERGED workspaces (read-only history)
    const mergedSessions: Session[] = workspaces
      .filter((ws) => ws.status === 'MERGED' && Array.isArray(ws.sessions))
      .flatMap((ws) => ws.sessions ?? [])

    return pickLatest(mergedSessions, [SessionStatus.COMPLETED, SessionStatus.FAILED, SessionStatus.CANCELLED])
  }, [workspaces])

  const sessionId = activeSession?.id ?? ''
  const isSessionActive = activeSession?.status === SessionStatus.RUNNING || activeSession?.status === SessionStatus.PENDING

  // ============ Provider Info ============

  const { data: providers } = useProviders()
  const activeProviderName = useMemo(() => {
    const pid = activeSession?.providerId
    if (!pid || !providers) return null
    const match = providers.find((p) => p.provider.id === pid)
    return match?.provider.name ?? null
  }, [activeSession?.providerId, providers])

  // Whether the displayed session comes from a MERGED workspace (read-only history, no active worktree)
  const isReadOnlySession = useMemo(() => {
    if (!activeSession || !workspaces) return false
    const hasActiveWs = workspaces.some((ws) => ws.status === 'ACTIVE' && ws.sessions?.some((s) => s.id === activeSession.id))
    return !hasActiveWs
  }, [activeSession, workspaces])

  // Derive workingDir from the active workspace's worktreePath
  const workingDir = useMemo(() => {
    if (!workspaces) return undefined
    for (const ws of workspaces) {
      if (ws.status === 'ACTIVE' && ws.worktreePath) {
        return ws.worktreePath
      }
    }
    return workspaces[0]?.worktreePath
  }, [workspaces])

  // Derive active workspace ID for Open in IDE
  const activeWorkspaceId = useMemo(() => {
    if (!workspaces) return undefined
    const active = workspaces.find(ws => ws.status === 'ACTIVE')
    return active?.id
  }, [workspaces])

  // ============ Git Status ============

  const { data: gitStatus } = useGitStatus(activeWorkspaceId ?? '')

  // Collect sessions from active workspace for ResolveConflictsDialog
  const activeWorkspaceSessions = useMemo(() => {
    if (!workspaces) return []
    const active = workspaces.find(ws => ws.status === 'ACTIVE')
    return active?.sessions ?? []
  }, [workspaces])

  // Active workspace branch name
  const activeWorkspaceBranch = useMemo(() => {
    if (!workspaces) return ''
    const active = workspaces.find(ws => ws.status === 'ACTIVE')
    return active?.branchName ?? ''
  }, [workspaces])

  // Active workspace AI-generated commit message
  const activeWorkspaceCommitMessage = useMemo(() => {
    if (!workspaces) return undefined
    const active = workspaces.find(ws => ws.status === 'ACTIVE')
    return active?.commitMessage
  }, [workspaces])

  // ============ Query Client & Mutations ============

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

  const sendMessageMutation = useSendMessage()
  const openInEditorMutation = useOpenInEditor()

  const handleOpenInIde = useCallback(() => {
    if (!activeWorkspaceId) return
    openInEditorMutation.mutate({ workspaceId: activeWorkspaceId })
  }, [activeWorkspaceId, openInEditorMutation])

  const handleDeleteTask = useCallback(() => {
    if (!task?.id || !onDeleteTask) return
    onDeleteTask(task.id)
    setIsDeleteConfirmOpen(false)
  }, [task?.id, onDeleteTask])

  // ============ WebSocket Log Stream ============

  const {
    isConnected,
    isLoadingSnapshot,
    logs,
    entries,
    attach,
  } = useNormalizedLogs({
    sessionId,
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
    }
    socket.on(ServerEvents.TASK_UPDATED, handleTaskUpdated)

    return () => {
      socket.off(ServerEvents.TASK_UPDATED, handleTaskUpdated)
      socket.emit(ClientEvents.UNSUBSCRIBE, { topic: 'task', id: task.id })
    }
  }, [task?.id, queryClient])

  // ---- Session 事件监听（依赖 sessionId）----
  useEffect(() => {
    if (!sessionId) return
    const socket = socketManager.connect()

    const handleSessionCompleted = (payload: SessionCompletedPayload) => {
      if (payload.sessionId !== sessionId) return
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
    }
    socket.on(ServerEvents.SESSION_COMPLETED, handleSessionCompleted)

    return () => {
      socket.off(ServerEvents.SESSION_COMPLETED, handleSessionCompleted)
    }
  }, [sessionId, queryClient])

  // Extract agent todos from the log stream
  const { todos } = useTodos(entries)

  // Attachments (file upload, paste, drag-drop)
  const { files: attachmentFiles, addFiles, removeFile, clear: clearAttachments, buildMarkdownLinks, hasFiles: hasAttachments, isUploading } = useAttachments()

  // Token usage — 取最新一条，回退到持久化值
  const initialTokenUsage = useMemo(() => {
    if (!activeSession?.tokenUsage) return undefined
    const tu = activeSession.tokenUsage
    if (typeof tu.totalTokens === 'number') return tu as { totalTokens: number; modelContextWindow?: number }
    return undefined
  }, [activeSession?.tokenUsage])
  const tokenUsage = useTokenUsage(logs, initialTokenUsage)

  // Auto-attach: 当 sessionId 或连接状态变化时自动 attach
  useEffect(() => {
    if (sessionId && isConnected) {
      attach()
    }
  }, [sessionId, isConnected, attach])

  // Note: no explicit detach effect needed here.
  // useNormalizedLogs' internal cleanup already sends UNSUBSCRIBE for the
  // old sessionId when sessionId changes (using the closure's stale value,
  // which is correct). An external detach() here would use the NEW sessionId
  // and incorrectly unsubscribe from the session we just attached to.

  // Scroll to bottom when switching tasks
  const prevTaskIdRef = useRef(task?.id)
  useEffect(() => {
    if (prevTaskIdRef.current !== task?.id) {
      scrollToBottom()
    }
    prevTaskIdRef.current = task?.id
  }, [task?.id, scrollToBottom])

  // ============ Session Actions ============

  const stopSession = useStopSession()

  const sendingRef = useRef(false)
  const handleSend = useCallback(async () => {
    if ((!input.trim() && !hasAttachments) || !sessionId || sendingRef.current || isUploading) return
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
    // 发送后需要 re-attach 以确保 WebSocket 订阅正确接收新 PTY 的输出。
    sendMessageMutation.mutate(
      { id: sessionId, message },
      {
        onSuccess: () => {
          // 后端已 spawn 新 PTY，重新 attach 以确保 socket room 和 MsgStore 监听正确
          attach()
        },
        onSettled: () => {
          sendingRef.current = false
        },
      }
    )
  }, [input, sessionId, sendMessageMutation, attach, hasAttachments, isUploading, buildMarkdownLinks, clearAttachments])

  const handleStop = useCallback(async () => {
    if (!sessionId) return
    await stopSession.mutateAsync(sessionId)
    queryClient.invalidateQueries({ queryKey: ['workspaces'] })
  }, [sessionId, stopSession, queryClient])

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

  // Resize event handlers (useCallback)
  const handleMouseMove = useCallback((e: MouseEvent) => {
    const deltaX = e.clientX - startXRef.current
    const newWidth = Math.max(CHAT_WIDTH_MIN, Math.min(startWidthRef.current + deltaX, CHAT_WIDTH_MAX))
    // Write directly to DOM via ref for smooth drag — no re-render until mouseup
    if (chatPanelRef.current) {
      chatPanelRef.current.style.width = `${newWidth}px`
    }
    // Store latest value in ref for mouseup to commit
    startWidthRef.current = startWidthRef.current // keep original start for delta calc
  }, [])

  const handleMouseUp = useCallback(() => {
    setIsResizing(false)
    // Commit final width from DOM to state
    if (chatPanelRef.current) {
      const finalWidth = chatPanelRef.current.getBoundingClientRect().width
      setChatWidth(Math.max(CHAT_WIDTH_MIN, Math.min(Math.round(finalWidth), CHAT_WIDTH_MAX)))
    }
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  // Attach/detach global listeners when resizing
  useEffect(() => {
    if (!isResizing) return

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing, handleMouseMove, handleMouseUp])

  const handleMouseDownResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    startXRef.current = e.clientX
    startWidthRef.current = chatWidth
    setIsResizing(true)
  }, [chatWidth])

  // Toggle workspace panel
  const handleToggleWorkspace = useCallback(() => {
    setIsWorkspaceOpen((prev) => !prev)
  }, [])

  // textarea auto-resize in onChange handler (not useEffect)
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    const scrollHeight = el.scrollHeight
    el.style.height = `${Math.max(60, Math.min(scrollHeight, 300))}px`
  }, [])

  // Build dynamic delete warning from workspace data
  const deleteDescription = useMemo(() => {
    const warnings: string[] = []

    if (workspaces && workspaces.length > 0) {
      const hasActive = workspaces.some(ws => ws.status === 'ACTIVE')
      const hasRunning = workspaces.some(ws =>
        ws.sessions?.some(s => s.status === SessionStatus.RUNNING || s.status === SessionStatus.PENDING)
      )
      const hasUnmerged = workspaces.some(ws => ws.status === 'ACTIVE')

      if (hasRunning) warnings.push('正在运行的 Agent 将被停止')
      if (hasUnmerged) warnings.push('分支上未合并的变更将丢失')
      if (hasActive) warnings.push('关联的工作目录（worktree）将被清理')
    }

    return warnings
  }, [workspaces])

  // Early return for null task
  if (!task) {
    return EMPTY_STATE
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-white relative overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 flex items-center justify-between border-b border-neutral-100 bg-white/80 backdrop-blur-sm z-20 flex-shrink-0">
        <div className="flex flex-col">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`text-xs font-semibold uppercase tracking-wider ${task.projectColor}`}>
              {task.projectName}
            </span>
            <span className="text-neutral-300 text-xs">/</span>
            <span className="text-xs text-neutral-500 font-mono">{task.branch}</span>
          </div>
          <h2 className="text-lg font-bold text-neutral-900">{task.title}</h2>
        </div>

        <div className="flex items-center gap-4">
          <StatusBadge
            status={task.status}
            onChangeStatus={onTaskStatusChange ? (newStatus) => onTaskStatusChange(task.id, newStatus) : undefined}
          />

          {/* Git Operations */}
          {activeWorkspaceId && (
            <button
              onClick={() => setIsGitDialogOpen(true)}
              className="w-8 h-8 flex items-center justify-center rounded-md text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 transition-colors"
              title="Git 操作"
            >
              <GitFork size={18} />
            </button>
          )}

          {/* Open in IDE */}
          <button
            onClick={handleOpenInIde}
            disabled={!activeWorkspaceId}
            className="w-8 h-8 flex items-center justify-center rounded-md text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Open in IDE"
          >
            <Code2 size={18} />
          </button>

          {/* Toggle Workspace */}
          <button
            onClick={handleToggleWorkspace}
            className="w-8 h-8 flex items-center justify-center rounded-md text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 transition-colors"
            title="Toggle Workspace"
          >
            {isWorkspaceOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>

          {/* More Actions */}
          {onDeleteTask && (
            <div className="relative" ref={moreMenuRef}>
              <button
                onClick={() => setIsMoreMenuOpen(v => !v)}
                className="w-8 h-8 flex items-center justify-center rounded-md text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 transition-colors"
                title="More actions"
              >
                <MoreVertical size={18} />
              </button>
              {isMoreMenuOpen && (
                <div className="absolute right-0 top-full mt-2 w-44 bg-white rounded-lg border border-neutral-200 shadow-lg z-50 py-1">
                  <button
                    onClick={() => {
                      setIsDeleteConfirmOpen(true)
                      setIsMoreMenuOpen(false)
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                  >
                    <Trash2 size={15} />
                    <span>删除任务</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Conflict Banner */}
      {activeWorkspaceId && gitStatus && (
        <ConflictBanner
          workspaceId={activeWorkspaceId}
          gitStatus={gitStatus}
          onResolve={() => setIsResolveDialogOpen(true)}
        />
      )}

      {/* Main Area — two-column layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Chat Panel (LogStream + Input) */}
        <div
          ref={chatPanelRef}
          className={`flex flex-col bg-white relative ${
            isWorkspaceOpen ? 'flex-shrink-0' : 'flex-1'
          }`}
          style={{ width: isWorkspaceOpen ? chatWidth : '100%' }}
        >
          {/* Scrollable Logs */}
          <div className="relative flex-1 min-h-0">
            <div ref={scrollRef} className="h-full overflow-y-auto px-6 pt-6 pb-4">
            <div ref={contentRef} className="w-full">
              {/* Task Description */}
              <div className="mb-4 pb-4 border-b border-neutral-100">
                {task.description ? (
                  <div className="text-sm text-neutral-500 leading-relaxed prose prose-sm max-w-none">
                    <Streamdown urlTransform={attachmentUrlTransform} components={streamdownComponents}>
                      {task.description}
                    </Streamdown>
                  </div>
                ) : (
                  <p className="text-sm text-neutral-400 italic">No description</p>
                )}
              </div>

              {/* Setup Script Progress */}
              {setupProgress && (
                <div className="flex items-center justify-center gap-2 py-3 text-neutral-400 text-sm">
                  {setupProgress.status === 'running' && (
                    <>
                      <svg className="animate-spin h-3.5 w-3.5 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      <span>Setup ({setupProgress.currentIndex}/{setupProgress.totalCommands}): <code>{setupProgress.currentCommand}</code></span>
                    </>
                  )}
                  {setupProgress.status === 'completed' && (
                    <span className="text-emerald-600">Setup 完成</span>
                  )}
                  {setupProgress.status === 'failed' && (
                    <span className="text-red-500">Setup 失败: {setupProgress.error}</span>
                  )}
                </div>
              )}

              {isLoadingWorkspaces ? (
                <div className="flex items-center justify-center py-12 gap-3 text-neutral-400">
                  <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="text-sm">Loading...</span>
                </div>
              ) : sessionId ? (
                isLoadingSnapshot ? (
                  <div className="flex items-center justify-center py-12 gap-3 text-neutral-400">
                    <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span className="text-sm">Loading logs...</span>
                  </div>
                ) : logs.length === 0 ? (
                  <div className="text-neutral-400 text-center py-8">
                    {isSessionActive ? 'Waiting for agent output...' : 'No logs recorded for this session.'}
                  </div>
                ) : (
                  <LogStream logs={logs} />
                )
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="w-14 h-14 bg-neutral-50 rounded-2xl border border-neutral-100 flex items-center justify-center mb-5">
                    <Play size={24} className="text-neutral-400 ml-0.5" />
                  </div>
                  <h3 className="text-base font-medium text-neutral-900 mb-1.5">
                    尚未启动 Agent
                  </h3>
                  <p className="text-sm text-neutral-500 mb-6 max-w-xs">
                    选择一个 Agent 来执行此任务，Agent 将自动创建工作空间并开始工作。
                  </p>
                  <Button onClick={() => setIsStartDialogOpen(true)}>
                    <Play size={16} className="mr-1.5" />
                    启动 Agent
                  </Button>
                </div>
              )}
            </div>
          </div>

            {/* Scroll to bottom button */}
            {!isAtBottom && (
              <button
                onClick={() => scrollToBottom()}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 bg-white/90 backdrop-blur-sm border border-neutral-200 rounded-full shadow-md text-xs text-neutral-600 hover:bg-white hover:text-neutral-900 transition-all"
                aria-label="Scroll to bottom"
              >
                <ArrowDown size={14} />
                <span>回到底部</span>
              </button>
            )}
          </div>

          {/* Todo Panel — fixed between logs and input */}
          {todos.length > 0 && (
            <div className="px-6 pt-2 pb-1 bg-white flex-shrink-0 border-t border-neutral-100">
              <TodoPanel todos={todos} />
            </div>
          )}

          {/* Input Area */}
          {isReadOnlySession ? (
            <div className="p-6 pt-3 bg-white flex-shrink-0 w-full z-10 pb-6 border-t border-neutral-100">
              <div className="flex items-center justify-between bg-neutral-50 rounded-xl border border-neutral-200 px-4 py-3">
                <span className="text-sm text-neutral-500">代码已合并，以上为历史沟通记录</span>
                <Button size="sm" onClick={() => setIsStartDialogOpen(true)}>
                  <Play size={14} className="mr-1.5" />
                  启动新 Agent
                </Button>
              </div>
            </div>
          ) : (
          <div
            className="p-6 pt-2 bg-white flex-shrink-0 w-full z-10 pb-6 border-t border-transparent"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className={`relative bg-white rounded-xl border shadow-sm hover:shadow-md focus-within:shadow-md focus-within:border-neutral-300 transition-all duration-200 ${
              isDragOver ? 'border-blue-400 bg-blue-50/50 shadow-md' : 'border-neutral-200'
            }`}>
              {/* Attachment Preview */}
              <AttachmentPreview files={attachmentFiles} onRemove={removeFile} />

              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInput}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.repeat && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                rows={1}
                placeholder={isDragOver ? 'Drop files here...' : sessionId && !isSessionActive ? 'Continue conversation...' : 'Message Agent...'}
                className="w-full px-4 pt-4 pb-2 bg-transparent border-none focus:outline-none resize-none text-sm text-neutral-900 placeholder-neutral-400 leading-relaxed"
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
                    className="p-2 text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 rounded-lg transition-colors"
                    title="Upload file"
                  >
                    <Paperclip size={18} />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {activeProviderName && (
                    <span className="flex items-center gap-1 text-xs text-neutral-400 px-2 py-1.5 max-w-[120px] select-none">
                      <Cpu size={14} className="shrink-0" />
                      <span className="truncate">{activeProviderName}</span>
                    </span>
                  )}
                  <TokenUsageIndicator usage={tokenUsage} />
                  {isSessionActive && !input.trim() && !hasAttachments ? (
                    <button
                      onClick={handleStop}
                      disabled={stopSession.isPending}
                      className="p-2 rounded-lg transition-all duration-200 bg-red-500 text-white hover:bg-red-600 shadow-md disabled:opacity-50"
                    >
                      <Square size={14} />
                    </button>
                  ) : (
                    <button
                      onClick={handleSend}
                      disabled={(!input.trim() && !hasAttachments) || isUploading}
                      className={`p-2 rounded-lg transition-all duration-200 ${
                        (input.trim() || hasAttachments) && !isUploading
                          ? 'bg-neutral-900 text-white shadow-md hover:bg-black'
                          : 'bg-transparent text-neutral-300 cursor-not-allowed'
                      }`}
                    >
                      <ArrowUp size={18} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
          )}
        </div>

        {/* Resizer — only visible when WorkspacePanel is open */}
        {isWorkspaceOpen && (
          <div
            className="w-1 cursor-col-resize hover:bg-neutral-200 active:bg-blue-400 transition-colors z-30 flex-shrink-0 border-l border-neutral-200"
            onMouseDown={handleMouseDownResize}
          />
        )}

        {/* Right: WorkspacePanel — takes remaining space */}
        {isWorkspaceOpen && (
          <div className="flex-1 flex flex-col min-w-0 bg-white">
            <WorkspacePanel sessionId={sessionId || undefined} workingDir={workingDir} projectId={task.projectId} />
          </div>
        )}
      </div>

      {/* Start Agent Dialog */}
      <StartAgentDialog
        isOpen={isStartDialogOpen}
        onClose={() => setIsStartDialogOpen(false)}
        taskId={task.id}
        taskTitle={task.title}
        taskDescription={task.description}
      />

      {/* Git Operations Dialog */}
      {activeWorkspaceId && (
        <GitOperationsDialog
          open={isGitDialogOpen}
          onOpenChange={setIsGitDialogOpen}
          workspaceId={activeWorkspaceId}
          branchName={activeWorkspaceBranch}
          targetBranch={task.mainBranch}
          commitMessage={activeWorkspaceCommitMessage}
          onConflict={() => setIsResolveDialogOpen(true)}
        />
      )}

      {/* Resolve Conflicts Dialog */}
      {activeWorkspaceId && gitStatus && gitStatus.conflictOp && (
        <ResolveConflictsDialog
          open={isResolveDialogOpen}
          onOpenChange={setIsResolveDialogOpen}
          workspaceId={activeWorkspaceId}
          conflictOp={gitStatus.conflictOp as ConflictOp}
          conflictedFiles={gitStatus.conflictedFiles}
          sourceBranch={activeWorkspaceBranch}
          targetBranch={task.mainBranch}
          sessions={activeWorkspaceSessions}
        />
      )}

      {/* Delete Confirm Dialog */}
      <ConfirmDialog
        isOpen={isDeleteConfirmOpen}
        onClose={() => setIsDeleteConfirmOpen(false)}
        onConfirm={handleDeleteTask}
        title="删除任务"
        description={
          <>
            <p>确认删除任务「{task.title}」？此操作不可撤销。</p>
            {deleteDescription.length > 0 && (
              <ul className="mt-2 space-y-1">
                {deleteDescription.map((w, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-amber-600">
                    <span className="mt-1 shrink-0 w-1.5 h-1.5 rounded-full bg-amber-400" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        }
        confirmText="删除"
        variant="danger"
        isLoading={isDeleting}
      />
    </div>
  )
}
