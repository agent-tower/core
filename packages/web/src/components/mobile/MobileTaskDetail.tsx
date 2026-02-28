import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useQueryClient } from '@tanstack/react-query'
import { SessionStatus, type Session } from '@agent-tower/shared'
import { LogStream, TodoPanel, TokenUsageIndicator } from '@/components/agent'
import {
  ArrowLeft, ArrowUp, ArrowDown, Paperclip, Play, Square,
  MessageSquare, FolderOpen, GitGraph, Code2, Trash2, MoreVertical, History,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { WorkspacePanel } from '@/components/workspace/WorkspacePanel'
import { MobileChangesView } from './MobileChangesView'
import { MobileHistoryView } from './MobileHistoryView'
import { useWorkspaces, useOpenInEditor } from '@/hooks/use-workspaces'
import { useNormalizedLogs } from '@/lib/socket/hooks/useNormalizedLogs'
import { useSendMessage, useStopSession } from '@/hooks/use-sessions'
import { useTodos } from '@/hooks/use-todos'
import { useTokenUsage } from '@/hooks/useTokenUsage'
import { useAttachments } from '@/hooks/use-attachments'
import { AttachmentPreview } from '@/components/ui/AttachmentPreview'
import { StartAgentDialog } from '@/components/task/StartAgentDialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { UITaskDetailData } from '@/components/task/types'
import { UITaskStatus } from '@/components/task/types'

interface MobileTaskDetailProps {
  task: UITaskDetailData
  onBack: () => void
  onDeleteTask?: (taskId: string) => void
  isDeleting?: boolean
}

type MobileTab = 'chat' | 'changes' | 'history' | 'workspace'

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

const TAB_CONFIG: { key: MobileTab; label: string; icon: typeof MessageSquare }[] = [
  { key: 'chat', label: 'Chat', icon: MessageSquare },
  { key: 'changes', label: 'Changes', icon: GitGraph },
  { key: 'history', label: 'History', icon: History },
  { key: 'workspace', label: 'Workspace', icon: FolderOpen },
]

// ============ Main Component ============

export function MobileTaskDetail({ task, onBack, onDeleteTask, isDeleting }: MobileTaskDetailProps) {
  const [activeTab, setActiveTab] = useState<MobileTab>('chat')
  const [input, setInput] = useState('')
  const [isStartDialogOpen, setIsStartDialogOpen] = useState(false)
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false)
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false)
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

    return (
      pickLatest([SessionStatus.RUNNING]) ??
      pickLatest([SessionStatus.PENDING]) ??
      pickLatest([SessionStatus.COMPLETED, SessionStatus.FAILED, SessionStatus.CANCELLED])
    )
  }, [workspaces])

  const sessionId = activeSession?.id ?? ''
  const isSessionActive = activeSession?.status === SessionStatus.RUNNING || activeSession?.status === SessionStatus.PENDING

  const workingDir = useMemo(() => {
    if (!workspaces) return undefined
    for (const ws of workspaces) {
      if (ws.status === 'ACTIVE' && ws.worktreePath) return ws.worktreePath
    }
    return workspaces[0]?.worktreePath
  }, [workspaces])

  const activeWorkspaceId = useMemo(() => {
    if (!workspaces) return undefined
    return workspaces.find(ws => ws.status === 'ACTIVE')?.id
  }, [workspaces])

  // Build dynamic delete warning from workspace data
  const deleteDescription = useMemo(() => {
    const warnings: string[] = []

    if (workspaces && workspaces.length > 0) {
      const hasActive = workspaces.some(ws => ws.status === 'ACTIVE')
      const hasRunning = workspaces.some(ws =>
        ws.sessions?.some(s => s.status === SessionStatus.RUNNING || s.status === SessionStatus.PENDING)
      )

      if (hasRunning) warnings.push('正在运行的 Agent 将被停止')
      if (hasActive) {
        warnings.push('分支上未合并的变更将丢失')
        warnings.push('关联的工作目录（worktree）将被清理')
      }
    }

    return warnings
  }, [workspaces])

  // ============ Mutations ============

  const sendMessageMutation = useSendMessage()
  const openInEditorMutation = useOpenInEditor()
  const stopSession = useStopSession()

  // ============ Log Stream ============

  const { isConnected, isLoadingSnapshot, logs, entries, attach } = useNormalizedLogs({
    sessionId,
    onExit: useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
    }, [queryClient]),
  })

  const { todos } = useTodos(entries)

  const { files: attachmentFiles, addFiles, removeFile, clear: clearAttachments, buildMarkdownLinks, hasFiles: hasAttachments, isUploading } = useAttachments()

  // Token usage — 取最新一条，回退到持久化值
  const initialTokenUsage = useMemo(() => {
    if (!activeSession?.tokenUsage) return undefined
    const tu = activeSession.tokenUsage
    if (typeof tu.totalTokens === 'number') return tu as { totalTokens: number; modelContextWindow?: number }
    return undefined
  }, [activeSession?.tokenUsage])
  const tokenUsage = useTokenUsage(logs, initialTokenUsage)

  useEffect(() => {
    if (sessionId && isConnected) attach()
  }, [sessionId, isConnected, attach])

  // Note: no explicit detach effect needed here.
  // useNormalizedLogs' internal cleanup already sends UNSUBSCRIBE for the
  // old sessionId when sessionId changes.

  // Scroll to bottom when switching tasks
  useEffect(() => {
    scrollToBottom()
  }, [task.id, scrollToBottom])

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
      { id: sessionId, message },
      {
        onSuccess: () => attach(),
        onSettled: () => { sendingRef.current = false },
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
    if (!activeWorkspaceId) return
    openInEditorMutation.mutate({ workspaceId: activeWorkspaceId })
  }, [activeWorkspaceId, openInEditorMutation])

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
            <div className="flex items-center gap-1 text-[11px] text-neutral-500 leading-tight">
              <span className={`font-medium ${task.projectColor}`}>{task.projectName}</span>
              <span className="text-neutral-300">/</span>
              <span className="font-mono truncate">{task.branch}</span>
            </div>
          </div>
          <StatusDot status={task.status} />
          <button
            onClick={handleOpenInIde}
            disabled={!activeWorkspaceId}
            className="p-1.5 text-neutral-400 active:text-neutral-900 disabled:opacity-30"
          >
            <Code2 size={16} />
          </button>
          {onDeleteTask && (
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
                    <span>删除任务</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sub-Tab Bar */}
        <div className="flex border-t border-neutral-100">
          {TAB_CONFIG.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex-1 flex items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors ${
                activeTab === key
                  ? 'text-neutral-900 border-b-2 border-neutral-900'
                  : 'text-neutral-400 border-b-2 border-transparent'
              }`}
            >
              <Icon size={13} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </header>

      {/* Content Area */}
      {activeTab === 'chat' && (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Scrollable Logs */}
          <div className="relative flex-1 min-h-0">
            <div ref={scrollRef} className="h-full overflow-y-auto overflow-x-hidden overscroll-y-contain px-3 pt-3 pb-2">
            <div ref={contentRef}>
            {/* Task Description */}
            <div className="mb-3 pb-2 border-b border-neutral-100">
              <p className="text-[13px] text-neutral-500 leading-relaxed">{task.description}</p>
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
                <h3 className="text-sm font-medium text-neutral-900 mb-1">尚未启动 Agent</h3>
                <p className="text-xs text-neutral-500 mb-5 max-w-[240px]">
                  选择一个 Agent 来执行此任务
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
                className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-2.5 py-1 bg-white/90 backdrop-blur-sm border border-neutral-200 rounded-full shadow-md text-[11px] text-neutral-600 active:bg-white transition-all"
                aria-label="Scroll to bottom"
              >
                <ArrowDown size={12} />
                <span>回到底部</span>
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
          {sessionId && (
            <div className="px-3 py-2 bg-white shrink-0 border-t border-neutral-100">
              <div className="relative bg-white rounded-xl border border-neutral-200 shadow-sm focus-within:border-neutral-300">
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
                    <TokenUsageIndicator usage={tokenUsage} />
                  </div>
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
          )}
        </div>
      )}

      {activeTab === 'changes' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
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
          <WorkspacePanel sessionId={sessionId || undefined} workingDir={workingDir} projectId={task.projectId} className="h-full" hideChanges />
        </div>
      )}

      {/* Start Agent Dialog */}
      <StartAgentDialog
        isOpen={isStartDialogOpen}
        onClose={() => setIsStartDialogOpen(false)}
        taskId={task.id}
        taskTitle={task.title}
        taskDescription={task.description}
      />

      {/* Delete Confirm Dialog */}
      <ConfirmDialog
        isOpen={isDeleteConfirmOpen}
        onClose={() => setIsDeleteConfirmOpen(false)}
        onConfirm={() => {
          onDeleteTask?.(task.id)
          setIsDeleteConfirmOpen(false)
        }}
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
