import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SessionStatus } from '@agent-tower/shared'
import { LogStream } from '@/components/agent'
import { TodoPanel } from '@/components/agent'
import { IconRunning, IconReview, IconPending, IconDone } from '@/components/agent'
import { Paperclip, ArrowUp, PanelRightClose, PanelRightOpen, Play, Square, Code2, Trash2, MoreVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { WorkspacePanel } from '@/components/workspace/WorkspacePanel'
import { useWorkspaces, useOpenInEditor } from '@/hooks/use-workspaces'
import { useNormalizedLogs } from '@/lib/socket/hooks/useNormalizedLogs'
import { useSendMessage, useStopSession } from '@/hooks/use-sessions'
import { useTodos } from '@/hooks/use-todos'
import { StartAgentDialog } from './StartAgentDialog'
import type { UITaskDetailData } from './types'
import { UITaskStatus } from './types'

interface TaskDetailProps {
  task: UITaskDetailData | null
  /** 删除任务回调 — 传入 taskId */
  onDeleteTask?: (taskId: string) => void
  /** 删除中状态 */
  isDeleting?: boolean
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

function StatusBadge({ status }: { status: UITaskStatus }) {
  const config = {
    [UITaskStatus.Running]: {
      className: 'bg-blue-50 text-blue-700 border-blue-100',
      icon: <IconRunning className="w-3 h-3 animate-pulse" />,
    },
    [UITaskStatus.Review]: {
      className: 'bg-amber-50 text-amber-700 border-amber-100',
      icon: <IconReview className="w-3 h-3" />,
    },
    [UITaskStatus.Pending]: {
      className: 'bg-neutral-50 text-neutral-600 border-neutral-100',
      icon: <IconPending className="w-3 h-3" />,
    },
    [UITaskStatus.Done]: {
      className: 'bg-emerald-50 text-emerald-700 border-emerald-100',
      icon: <IconDone className="w-3 h-3" />,
    },
  }

  const { className, icon } = config[status]

  return (
    <div
      className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border ${className}`}
    >
      {icon}
      <span>{status}</span>
    </div>
  )
}

// ============ TaskDetail Component ============

export function TaskDetail({ task, onDeleteTask, isDeleting }: TaskDetailProps) {
  const [input, setInput] = useState('')
  const [isStartDialogOpen, setIsStartDialogOpen] = useState(false)
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false)
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  /**
   * Scroll-lock state machine (inspired by vibe-kanban's useScrollSyncStateMachine):
   * - 'following': auto-scroll is active, new logs scroll to bottom
   * - 'user-scrolling': user initiated a scroll (wheel/touch), auto-scroll paused
   * - 'programmatic': we triggered a scroll, ignore scroll events briefly
   */
  const scrollStateRef = useRef<'following' | 'user-scrolling' | 'programmatic'>('following')
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isInitialLoad, setIsInitialLoad] = useState(true)

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

  // Find the latest active session from workspaces
  const activeSession = useMemo(() => {
    if (!workspaces) return null
    for (const ws of workspaces) {
      if (ws.status !== 'ACTIVE' || !ws.sessions) continue
      // Prefer RUNNING, then PENDING, then latest COMPLETED/FAILED for history
      const running = ws.sessions.find(s => s.status === SessionStatus.RUNNING)
      if (running) return running
      const pending = ws.sessions.find(s => s.status === SessionStatus.PENDING)
      if (pending) return pending
    }
    // Fallback: find the most recent completed/failed/cancelled session for history replay
    for (const ws of workspaces) {
      if (!ws.sessions) continue
      const finished = ws.sessions.find(
        s => s.status === SessionStatus.COMPLETED || s.status === SessionStatus.FAILED || s.status === SessionStatus.CANCELLED
      )
      if (finished) return finished
    }
    return null
  }, [workspaces])

  const sessionId = activeSession?.id ?? ''
  const isSessionActive = activeSession?.status === SessionStatus.RUNNING || activeSession?.status === SessionStatus.PENDING

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

  // Extract agent todos from the log stream
  const { todos } = useTodos(entries)

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

  // Reset scroll state when switching tasks — new task should always start at bottom
  const prevTaskIdRef = useRef(task?.id)
  useEffect(() => {
    if (prevTaskIdRef.current !== task?.id) {
      scrollStateRef.current = 'following'
      setIsInitialLoad(true)
      if (cooldownTimerRef.current) {
        clearTimeout(cooldownTimerRef.current)
        cooldownTimerRef.current = null
      }
    }
    prevTaskIdRef.current = task?.id
  }, [task?.id])

  // User-initiated scroll detection: wheel/touchmove = user wants to look around
  const handleUserScrollIntent = useCallback(() => {
    // If we're in a programmatic scroll cooldown, ignore
    if (scrollStateRef.current === 'programmatic') return
    scrollStateRef.current = 'user-scrolling'
  }, [])

  // When user scrolls back to the very bottom, re-engage auto-scroll
  const handleScroll = useCallback(() => {
    if (scrollStateRef.current !== 'user-scrolling') return
    const el = scrollContainerRef.current
    if (!el) return
    // Only re-engage when user has scrolled all the way to the bottom (within 2px tolerance)
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 2) {
      scrollStateRef.current = 'following'
    }
  }, [])

  // Attach wheel/touch listeners to detect user-initiated scrolls
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    // wheel and touchmove are the only events that indicate user intent
    // (as opposed to programmatic scrollIntoView which only fires 'scroll')
    el.addEventListener('wheel', handleUserScrollIntent, { passive: true })
    el.addEventListener('touchmove', handleUserScrollIntent, { passive: true })
    return () => {
      el.removeEventListener('wheel', handleUserScrollIntent)
      el.removeEventListener('touchmove', handleUserScrollIntent)
    }
  }, [handleUserScrollIntent])

  // Auto-scroll to bottom when logs change — respects scroll state machine
  useEffect(() => {
    if (scrollStateRef.current !== 'following') return

    if (isInitialLoad && logs.length > 0) {
      // Initial load (task switch / history replay): wait for DOM to fully settle, then jump instantly
      setIsInitialLoad(false)
      // Double rAF: first rAF schedules after React commit, second after browser layout/paint
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          bottomRef.current?.scrollIntoView({ behavior: 'instant' })
        })
      })
      return
    }

    // Streaming updates: smooth scroll
    scrollStateRef.current = 'programmatic'
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current)
    cooldownTimerRef.current = setTimeout(() => {
      if (scrollStateRef.current === 'programmatic') {
        scrollStateRef.current = 'following'
      }
    }, 300)
  }, [logs])

  // Also scroll to bottom when snapshot finishes loading (isLoadingSnapshot: true → false with content)
  const prevLoadingRef = useRef(isLoadingSnapshot)
  useEffect(() => {
    const wasLoading = prevLoadingRef.current
    prevLoadingRef.current = isLoadingSnapshot
    if (wasLoading && !isLoadingSnapshot) {
      // Snapshot finished loading — end initial load state regardless of content
      setIsInitialLoad(false)
      if (logs.length > 0) {
        scrollStateRef.current = 'following'
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            bottomRef.current?.scrollIntoView({ behavior: 'instant' })
          })
        })
      }
    }
  }, [isLoadingSnapshot, logs.length])

  // ============ Session Actions ============

  const stopSession = useStopSession()

  const sendingRef = useRef(false)
  const handleSend = useCallback(async () => {
    if (!input.trim() || !sessionId || sendingRef.current) return
    sendingRef.current = true
    const message = input.trim()
    setInput('')
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
  }, [input, sessionId, sendMessageMutation, attach])

  const handleStop = useCallback(async () => {
    if (!sessionId) return
    await stopSession.mutateAsync(sessionId)
    queryClient.invalidateQueries({ queryKey: ['workspaces'] })
  }, [sessionId, stopSession, queryClient])

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
          <StatusBadge status={task.status} />

          {/* Open in IDE */}
          <button
            onClick={handleOpenInIde}
            disabled={!activeWorkspaceId}
            className="text-neutral-400 hover:text-neutral-900 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Open in IDE"
          >
            <Code2 size={20} />
          </button>

          {/* Toggle Workspace */}
          <button
            onClick={handleToggleWorkspace}
            className="text-neutral-400 hover:text-neutral-900 transition-colors"
            title="Toggle Workspace"
          >
            {isWorkspaceOpen ? <PanelRightClose size={20} /> : <PanelRightOpen size={20} />}
          </button>

          {/* More Actions */}
          {onDeleteTask && (
            <div className="relative" ref={moreMenuRef}>
              <button
                onClick={() => setIsMoreMenuOpen(v => !v)}
                className="text-neutral-400 hover:text-neutral-900 transition-colors"
                title="More actions"
              >
                <MoreVertical size={20} />
              </button>
              {isMoreMenuOpen && (
                <div className="absolute right-0 top-full mt-2 w-44 bg-white rounded-lg border border-neutral-200 shadow-lg z-50 py-1">
                  {!isDeleteConfirmOpen ? (
                    <button
                      onClick={() => setIsDeleteConfirmOpen(true)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <Trash2 size={15} />
                      <span>删除任务</span>
                    </button>
                  ) : (
                    <div className="px-3 py-2">
                      <p className="text-xs text-neutral-500 mb-2">确认删除此任务？</p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            handleDeleteTask()
                            setIsMoreMenuOpen(false)
                          }}
                          disabled={isDeleting}
                          className="flex-1 px-2 py-1 text-xs font-medium text-white bg-red-500 hover:bg-red-600 rounded transition-colors disabled:opacity-50"
                        >
                          {isDeleting ? '...' : '确认'}
                        </button>
                        <button
                          onClick={() => setIsDeleteConfirmOpen(false)}
                          className="flex-1 px-2 py-1 text-xs font-medium text-neutral-600 bg-neutral-100 hover:bg-neutral-200 rounded transition-colors"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

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
          <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-6 pt-6 pb-4">
            <div className="w-full">
              {/* Task Description */}
              <div className="mb-4 pb-4 border-b border-neutral-100">
                <p className="text-sm text-neutral-500 leading-relaxed">{task.description}</p>
              </div>

              {isLoadingWorkspaces ? (
                <div className="flex items-center justify-center py-12 gap-3 text-neutral-400">
                  <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="text-sm">Loading...</span>
                </div>
              ) : sessionId ? (
                isLoadingSnapshot || (logs.length === 0 && isInitialLoad) ? (
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
              <div ref={bottomRef} className="h-4" />
            </div>
          </div>

          {/* Todo Panel — fixed between logs and input */}
          {todos.length > 0 && (
            <div className="px-6 pt-3 pb-1 bg-white flex-shrink-0 border-t border-neutral-100">
              <TodoPanel todos={todos} />
            </div>
          )}

          {/* Input Area */}
          <div className="p-6 pt-2 bg-white flex-shrink-0 w-full z-10 pb-6 border-t border-transparent">
            <div className="relative bg-white rounded-xl border border-neutral-200 shadow-sm hover:shadow-md focus-within:shadow-md focus-within:border-neutral-300 transition-all duration-200">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInput}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.repeat && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                rows={1}
                placeholder={sessionId && !isSessionActive ? 'Continue conversation...' : 'Message Agent...'}
                className="w-full px-4 pt-4 pb-2 bg-transparent border-none focus:outline-none resize-none text-sm text-neutral-900 placeholder-neutral-400 leading-relaxed"
                style={{ minHeight: '60px', maxHeight: '300px' }}
              />

              {/* Toolbar Row */}
              <div className="flex items-center justify-between px-2 pb-2 pt-1">
                <div className="flex items-center gap-1">
                  <button className="p-2 text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 rounded-lg transition-colors">
                    <Paperclip size={18} />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {isSessionActive && !input.trim() ? (
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
                      disabled={!input.trim()}
                      className={`p-2 rounded-lg transition-all duration-200 ${
                        input.trim()
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
        </div>

        {/* Resizer — only visible when WorkspacePanel is open */}
        {isWorkspaceOpen && (
          <div
            className="w-1 cursor-col-resize hover:bg-neutral-200 active:bg-blue-400 transition-colors z-30 flex-shrink-0"
            onMouseDown={handleMouseDownResize}
          />
        )}

        {/* Right: WorkspacePanel — takes remaining space */}
        {isWorkspaceOpen && (
          <div className="flex-1 flex flex-col min-w-0 bg-white">
            <WorkspacePanel sessionId={sessionId || undefined} workingDir={workingDir} />
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
    </div>
  )
}
