import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { SessionStatus } from '@agent-tower/shared'
import { LogStream } from '@/components/agent'
import { IconRunning, IconReview, IconPending, IconDone } from '@/components/agent'
import { Paperclip, ArrowUp, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { WorkspacePanel } from '@/components/workspace/WorkspacePanel'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { useNormalizedLogs } from '@/lib/socket/hooks/useNormalizedLogs'
import { useSendMessage } from '@/hooks/use-sessions'
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
    // Fallback: find the most recent completed/failed session for history replay
    for (const ws of workspaces) {
      if (!ws.sessions) continue
      const finished = ws.sessions.find(
        s => s.status === SessionStatus.COMPLETED || s.status === SessionStatus.FAILED
      )
      if (finished) return finished
    }
    return null
  }, [workspaces])

  const sessionId = activeSession?.id ?? ''
  const isSessionActive = activeSession?.status === SessionStatus.RUNNING || activeSession?.status === SessionStatus.PENDING

  // ============ WebSocket Log Stream ============

  const {
    isConnected,
    isAttached,
    logs,
    attach,
    detach,
  } = useNormalizedLogs({
    sessionId,
  })

  // Auto-attach when sessionId and socket are ready
  useEffect(() => {
    if (sessionId && isConnected && !isAttached) {
      attach()
    }
  }, [sessionId, isConnected, isAttached, attach])

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

  // ============ Message Sending ============

  const sendMessageMutation = useSendMessage()

  const handleSend = useCallback(() => {
    if (!input.trim() || !sessionId) return
    sendMessageMutation.mutate({ id: sessionId, message: input.trim() })
    setInput('')
    if (textareaRef.current) {
      textareaRef.current.style.height = '60px'
    }
  }, [input, sessionId, sendMessageMutation])

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
              <div className="mb-8 pb-8 border-b border-neutral-100">
                <p className="text-sm text-neutral-500 leading-relaxed">{task.description}</p>
              </div>

              {sessionId ? (
                logs.length === 0 ? (
                  <div className="text-neutral-400 text-center py-8">
                    {isSessionActive ? 'Waiting for agent output...' : 'No logs recorded for this session.'}
                  </div>
                ) : (
                  <LogStream logs={logs} />
                )
              ) : (
                <div className="text-neutral-400 text-center py-8">
                  No agent session yet. Start an agent to begin.
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
                placeholder="Message Agent..."
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
            <WorkspacePanel branch={task.branch} />
          </div>
        )}
      </div>
    </div>
  )
}
