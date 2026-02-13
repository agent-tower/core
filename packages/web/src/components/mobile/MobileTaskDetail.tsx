import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SessionStatus, type Session } from '@agent-tower/shared'
import { LogStream, TodoPanel, TokenUsageIndicator } from '@/components/agent'
import type { LogStreamHandle } from '@/components/agent'
import {
  ArrowLeft, ArrowUp, Paperclip, Play, Square,
  MessageSquare, FolderOpen, GitGraph, Code2, Trash2, MoreVertical,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { WorkspacePanel } from '@/components/workspace/WorkspacePanel'
import { MobileChangesView } from './MobileChangesView'
import { useWorkspaces, useOpenInEditor } from '@/hooks/use-workspaces'
import { useNormalizedLogs } from '@/lib/socket/hooks/useNormalizedLogs'
import { useSendMessage, useStopSession } from '@/hooks/use-sessions'
import { useTodos } from '@/hooks/use-todos'
import { useTokenUsage } from '@/hooks/useTokenUsage'
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

type MobileTab = 'chat' | 'changes' | 'workspace'

// ============ Status Badge ============

function StatusDot({ status }: { status: UITaskStatus }) {
  const colors: Record<UITaskStatus, string> = {
    [UITaskStatus.Running]: 'bg-blue-500',
    [UITaskStatus.Review]: 'bg-amber-500',
    [UITaskStatus.Pending]: 'bg-neutral-400',
    [UITaskStatus.Done]: 'bg-emerald-500',
  }
  return <span className={`w-2.5 h-2.5 rounded-full ${colors[status]}`} />
}

// ============ Tab Bar ============

const TAB_CONFIG: { key: MobileTab; label: string; icon: typeof MessageSquare }[] = [
  { key: 'chat', label: 'Chat', icon: MessageSquare },
  { key: 'changes', label: 'Changes', icon: GitGraph },
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
  const logStreamRef = useRef<LogStreamHandle>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const scrollStateRef = useRef<'following' | 'user-scrolling' | 'programmatic'>('following')
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isInitialLoad, setIsInitialLoad] = useState(true)

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

  // Reset scroll on task change
  useEffect(() => {
    scrollStateRef.current = 'following'
    setIsInitialLoad(true)
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current)
  }, [task.id])

  // Scroll detection
  const handleUserScrollIntent = useCallback(() => {
    if (scrollStateRef.current === 'programmatic') return
    scrollStateRef.current = 'user-scrolling'
  }, [])

  const handleScroll = useCallback(() => {
    if (scrollStateRef.current !== 'user-scrolling') return
    const el = scrollContainerRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 2) {
      scrollStateRef.current = 'following'
    }
  }, [])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    el.addEventListener('wheel', handleUserScrollIntent, { passive: true })
    el.addEventListener('touchmove', handleUserScrollIntent, { passive: true })
    return () => {
      el.removeEventListener('wheel', handleUserScrollIntent)
      el.removeEventListener('touchmove', handleUserScrollIntent)
    }
  }, [handleUserScrollIntent])

  // Auto-scroll
  useEffect(() => {
    if (scrollStateRef.current !== 'following') return
    if (isInitialLoad && logs.length > 0) {
      setIsInitialLoad(false)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          logStreamRef.current?.scrollToBottom('instant')
        })
      })
      return
    }
    scrollStateRef.current = 'programmatic'
    logStreamRef.current?.scrollToBottom('smooth')
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current)
    cooldownTimerRef.current = setTimeout(() => {
      if (scrollStateRef.current === 'programmatic') scrollStateRef.current = 'following'
    }, 300)
  }, [logs])

  // Snapshot loaded
  const prevLoadingRef = useRef(isLoadingSnapshot)
  useEffect(() => {
    const wasLoading = prevLoadingRef.current
    prevLoadingRef.current = isLoadingSnapshot
    if (wasLoading && !isLoadingSnapshot) {
      setIsInitialLoad(false)
      if (logs.length > 0) {
        scrollStateRef.current = 'following'
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            logStreamRef.current?.scrollToBottom('instant')
          })
        })
      }
    }
  }, [isLoadingSnapshot, logs.length])

  // ============ Actions ============

  const sendingRef = useRef(false)
  const handleSend = useCallback(async () => {
    if (!input.trim() || !sessionId || sendingRef.current) return
    sendingRef.current = true
    const message = input.trim()
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = '48px'

    sendMessageMutation.mutate(
      { id: sessionId, message },
      {
        onSuccess: () => attach(),
        onSettled: () => { sendingRef.current = false },
      }
    )
  }, [input, sessionId, sendMessageMutation, attach])

  const handleStop = useCallback(async () => {
    if (!sessionId) return
    await stopSession.mutateAsync(sessionId)
    queryClient.invalidateQueries({ queryKey: ['workspaces'] })
  }, [sessionId, stopSession, queryClient])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.max(48, Math.min(el.scrollHeight, 160))}px`
  }, [])

  const handleOpenInIde = useCallback(() => {
    if (!activeWorkspaceId) return
    openInEditorMutation.mutate({ workspaceId: activeWorkspaceId })
  }, [activeWorkspaceId, openInEditorMutation])

  // ============ Render ============

  return (
    <div className="flex flex-col h-dvh bg-white overflow-hidden">
      {/* Header */}
      <header className="shrink-0 bg-white border-b border-neutral-200 z-20">
        <div className="flex items-center h-12 px-3 gap-2">
          <button onClick={onBack} className="p-2 -ml-1 text-neutral-600 active:text-neutral-900">
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-bold text-neutral-900 truncate">{task.title}</h1>
            <div className="flex items-center gap-1.5 text-xs text-neutral-500">
              <span className={`font-medium ${task.projectColor}`}>{task.projectName}</span>
              <span className="text-neutral-300">/</span>
              <span className="font-mono truncate">{task.branch}</span>
            </div>
          </div>
          <StatusDot status={task.status} />
          <button
            onClick={handleOpenInIde}
            disabled={!activeWorkspaceId}
            className="p-2 text-neutral-400 active:text-neutral-900 disabled:opacity-30"
          >
            <Code2 size={18} />
          </button>
          {onDeleteTask && (
            <div className="relative" ref={moreMenuRef}>
              <button
                onClick={() => setIsMoreMenuOpen(v => !v)}
                className="p-2 text-neutral-400 active:text-neutral-900"
                aria-label="More actions"
              >
                <MoreVertical size={18} />
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
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
                activeTab === key
                  ? 'text-neutral-900 border-b-2 border-neutral-900'
                  : 'text-neutral-400 border-b-2 border-transparent'
              }`}
            >
              <Icon size={14} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </header>

      {/* Content Area */}
      {activeTab === 'chat' && (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Scrollable Logs */}
          <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 pt-4 pb-2">
            {/* Task Description */}
            <div className="mb-4 pb-3 border-b border-neutral-100">
              <p className="text-sm text-neutral-500 leading-relaxed">{task.description}</p>
            </div>

            {isLoadingWorkspaces ? (
              <LoadingSpinner label="Loading..." />
            ) : sessionId ? (
              isLoadingSnapshot || (logs.length === 0 && isInitialLoad) ? (
                <LoadingSpinner label="Loading logs..." />
              ) : logs.length === 0 ? (
                <div className="text-neutral-400 text-center py-8 text-sm">
                  {isSessionActive ? 'Waiting for agent output...' : 'No logs recorded.'}
                </div>
              ) : (
                <LogStream ref={logStreamRef} logs={logs} scrollElementRef={scrollContainerRef} />
              )
            ) : (
              /* No session — show start agent CTA */
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-14 h-14 bg-neutral-50 rounded-2xl border border-neutral-100 flex items-center justify-center mb-5">
                  <Play size={24} className="text-neutral-400 ml-0.5" />
                </div>
                <h3 className="text-base font-medium text-neutral-900 mb-1.5">尚未启动 Agent</h3>
                <p className="text-sm text-neutral-500 mb-6 max-w-xs">
                  选择一个 Agent 来执行此任务
                </p>
                <Button onClick={() => setIsStartDialogOpen(true)}>
                  <Play size={16} className="mr-1.5" />
                  启动 Agent
                </Button>
              </div>
            )}
          </div>

          {/* Todo Panel */}
          {todos.length > 0 && (
            <div className="px-4 pt-2 pb-1 bg-white shrink-0 border-t border-neutral-100">
              <TodoPanel todos={todos} />
            </div>
          )}

          {/* Input Area */}
          {sessionId && (
            <div className="p-3 bg-white shrink-0 border-t border-neutral-100">
              <div className="relative bg-white rounded-xl border border-neutral-200 shadow-sm focus-within:border-neutral-300">
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
                  placeholder={!isSessionActive ? 'Continue conversation...' : 'Message Agent...'}
                  className="w-full px-3 pt-3 pb-1 bg-transparent border-none focus:outline-none resize-none text-sm text-neutral-900 placeholder-neutral-400"
                  style={{ minHeight: 48, maxHeight: 160 }}
                />
                <div className="flex items-center justify-between px-2 pb-2">
                  <div className="flex items-center gap-1">
                    <button className="p-1.5 text-neutral-400 active:text-neutral-600 rounded-lg">
                      <Paperclip size={16} />
                    </button>
                    <TokenUsageIndicator usage={tokenUsage} />
                  </div>
                  {isSessionActive && !input.trim() ? (
                    <button
                      onClick={handleStop}
                      disabled={stopSession.isPending}
                      className="p-1.5 rounded-lg bg-red-500 text-white active:bg-red-600 disabled:opacity-50"
                    >
                      <Square size={14} />
                    </button>
                  ) : (
                    <button
                      onClick={handleSend}
                      disabled={!input.trim()}
                      className={`p-1.5 rounded-lg transition-colors ${
                        input.trim()
                          ? 'bg-neutral-900 text-white active:bg-black'
                          : 'bg-transparent text-neutral-300'
                      }`}
                    >
                      <ArrowUp size={16} />
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

      {activeTab === 'workspace' && (
        <div className="flex-1 overflow-hidden">
          <WorkspacePanel sessionId={sessionId || undefined} workingDir={workingDir} className="h-full" hideChanges />
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
