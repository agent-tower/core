import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SessionStatus } from '@agent-tower/shared'
import { LogStream } from '@/components/agent'
import { IconRunning, IconReview, IconPending, IconDone } from '@/components/agent'
import { Paperclip, ArrowUp, PanelRightClose, PanelRightOpen, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { WorkspacePanel } from '@/components/workspace/WorkspacePanel'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { useNormalizedLogs } from '@/lib/socket/hooks/useNormalizedLogs'
import { useSendMessage, useStopSession, useResumeSession } from '@/hooks/use-sessions'
import { StartAgentDialog } from './StartAgentDialog'
import type { UITaskDetailData } from './types'
import { UITaskStatus } from './types'

interface TaskDetailProps {
  task: UITaskDetailData | null
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

export function TaskDetail({ task }: TaskDetailProps) {
  const [input, setInput] = useState('')
  const [isStartDialogOpen, setIsStartDialogOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Layout state
  const [chatWidth, setChatWidth] = useState(CHAT_WIDTH_DEFAULT)
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState(true)
  const [isResizing, setIsResizing] = useState(false)

  // Transient refs for resize — avoid re-renders during drag (rerender-use-ref-transient-values)
  const startXRef = useRef<number>(0)
  const startWidthRef = useRef<number>(0)
  const chatPanelRef = useRef<HTMLDivElement>(null)

  // ============ Session Discovery ============

  const { data: workspaces } = useWorkspaces(task?.id ?? '')

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

  // ============ Query Client & Mutations ============

  const queryClient = useQueryClient()
  const sendMessageMutation = useSendMessage()

  // ============ WebSocket Log Stream ============

  const {
    isConnected,
    isLoadingSnapshot,
    logs,
    attach,
    detach,
    clearLogs,
  } = useNormalizedLogs({
    sessionId,
    onExit: useCallback(() => {
      // Agent PTY 退出后，刷新 workspaces query 让 isSessionActive 更新（停止按钮变回发送按钮）
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
    }, [queryClient]),
  })

  // Auto-attach: 仅在 sessionId 变化或首次连接/重连时 attach
  // 不依赖 isAttached —— 避免 EXIT/DETACH 事件导致 isAttached=false 后
  // 自动 re-attach，触发 loadSnapshot 覆盖实时流状态
  const hasAttachedRef = useRef(false)
  useEffect(() => {
    // Reset when sessionId changes
    hasAttachedRef.current = false
  }, [sessionId])

  useEffect(() => {
    if (!isConnected) {
      // Socket 断开时重置，下次 reconnect 时需要重新 attach
      hasAttachedRef.current = false
      return
    }

    if (sessionId && !hasAttachedRef.current) {
      hasAttachedRef.current = true
      attach()
    }
  }, [sessionId, isConnected, attach])

  // Detach when sessionId changes (cleanup handled by useNormalizedLogs internally)
  const prevSessionIdRef = useRef(sessionId)
  useEffect(() => {
    if (prevSessionIdRef.current && prevSessionIdRef.current !== sessionId) {
      detach()
    }
    prevSessionIdRef.current = sessionId
  }, [sessionId, detach])

  // Auto-scroll to bottom when logs change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // ============ Session Actions ============

  const stopSession = useStopSession()
  const resumeSession = useResumeSession()

  const handleSend = useCallback(async () => {
    if (!input.trim() || !sessionId) return
    const message = input.trim()
    setInput('')
    if (textareaRef.current) {
      textareaRef.current.style.height = '60px'
    }

    if (isSessionActive) {
      // Running session: 直接写入 PTY stdin（后端会注入 user_message patch）
      sendMessageMutation.mutate({ id: sessionId, message })
    } else {
      // 已结束 session: resume 恢复会话
      // 后端会创建全新的 MsgStore，需要 detach → clearLogs → re-attach
      try {
        await resumeSession.mutateAsync({ id: sessionId, message })
        // Resume 成功，后端创建了全新的 MsgStore + PTY
        // 需要 detach 旧的 WebSocket 订阅，清空前端日志，重新 attach
        detach()
        clearLogs()
        // invalidate workspaces 让 isSessionActive 更新
        queryClient.invalidateQueries({ queryKey: ['workspaces'] })
        // 重置 hasAttachedRef 允许重新 attach
        hasAttachedRef.current = false
        // 短暂延迟让后端 PTY pipeline 就绪，然后重新 attach
        setTimeout(() => {
          attach()
        }, 500)
      } catch (error) {
        console.error('[TaskDetail] Resume failed:', error)
      }
    }
  }, [input, sessionId, isSessionActive, sendMessageMutation, resumeSession, detach, clearLogs, attach, queryClient])

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

          {/* Toggle Workspace */}
          <button
            onClick={handleToggleWorkspace}
            className="text-neutral-400 hover:text-neutral-900 transition-colors"
            title="Toggle Workspace"
          >
            {isWorkspaceOpen ? <PanelRightClose size={20} /> : <PanelRightOpen size={20} />}
          </button>
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
          <div className="flex-1 overflow-y-auto px-6 pt-6 pb-4">
            <div className="w-full">
              {/* Task Description */}
              <div className="mb-4 pb-4 border-b border-neutral-100">
                <p className="text-sm text-neutral-500 leading-relaxed">{task.description}</p>
              </div>

              {sessionId ? (
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
              <div ref={bottomRef} className="h-4" />
            </div>
          </div>

          {/* Input Area */}
          <div className="p-6 pt-4 bg-white flex-shrink-0 w-full z-10 pb-6 border-t border-transparent">
            <div className="relative bg-white rounded-xl border border-neutral-200 shadow-sm hover:shadow-md focus-within:shadow-md focus-within:border-neutral-300 transition-all duration-200">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInput}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
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
            <WorkspacePanel branch={task.branch} workingDir={workingDir} />
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
