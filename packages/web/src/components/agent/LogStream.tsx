import { useState, useMemo, useImperativeHandle, forwardRef, memo, useRef, useEffect } from 'react'
import { type LogEntry, LogType, type ToolStatus } from '@agent-tower/shared/log-adapter'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { Streamdown } from 'streamdown'
import { Tooltip } from '@/components/ui/tooltip'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  createMessageStreamdownComponents,
  streamdownMermaidControls,
  type OpenPreviewUrlHandler,
} from '@/lib/streamdown-components'
import { useStreamdownMermaidPlugins } from '@/lib/streamdown-mermaid'
import 'streamdown/styles.css'

interface LogStreamProps {
  logs: LogEntry[]
  /** Whether the latest agent turn is still producing output. Omit to keep legacy rendering. */
  isOutputActive?: boolean
  /** Precise end time for the latest turn observed in this client. */
  lastExitAt?: number | null
  /** Stops automatic bottom-following before the user expands historical output. */
  onUserToggleDetails?: () => void
  workingDir?: string
  onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void
  onOpenPreviewUrl?: OpenPreviewUrlHandler
  /** 外部滚动容器 ref，用于滚动到底部（可选，仅 legacy 用法需要） */
  scrollElementRef?: React.RefObject<HTMLDivElement | null>
}

export interface LogStreamHandle {
  scrollToBottom: (behavior?: 'instant' | 'smooth') => void
}

// ============ Grouping Logic ============

type RenderItem =
  | { kind: 'single'; log: LogEntry; key: string }
  | { kind: 'execution-group'; logs: LogEntry[]; key: string }

interface ConversationTurn {
  key: string
  user?: LogEntry
  agentLogs: LogEntry[]
}

function getToolStatus(log: LogEntry): ToolStatus | undefined {
  if (log.tool?.status) return log.tool.status
  if (log.title?.endsWith('✓')) return 'success'
  if (log.title?.endsWith('✗')) return 'failed'
  if (log.title?.includes('待审批')) return 'pending_approval'
  return undefined
}

function isToolSuccess(log: LogEntry): boolean {
  return getToolStatus(log) === 'success'
}

function isToolFailure(log: LogEntry): boolean {
  const status = getToolStatus(log)
  return status === 'failed' || status === 'timed_out'
}

function isThinkingLog(log: LogEntry): boolean {
  return log.title === 'Thinking' || log.content.startsWith('Thinking:')
}

function isExistingToolGroup(log: LogEntry): boolean {
  return log.type === LogType.Tool && Boolean(log.children?.length)
}

function isEmptyNonCursorLog(log: LogEntry): boolean {
  return log.type !== LogType.Cursor && !log.children?.length && log.content.trim() === ''
}

function shouldSkipProjectedLog(log: LogEntry): boolean {
  return Boolean(log.tokenUsage) || isEmptyNonCursorLog(log)
}

function requiresUserAction(log: LogEntry): boolean {
  const status = log.tool?.status
  return status === 'pending_approval' || status === 'denied'
}

function isMainlineLog(log: LogEntry): boolean {
  if (log.type === LogType.Cursor) return true
  if (log.type === LogType.User || log.type === LogType.Assistant || isThinkingLog(log)) return true
  if (log.type === LogType.Error) return true
  if (log.type === LogType.Info && log.tokenUsage) return false
  return requiresUserAction(log)
}

function isExecutionDetailLog(log: LogEntry): boolean {
  if (isExistingToolGroup(log)) return false
  if (log.type !== LogType.Tool && log.type !== LogType.Action) return false
  return !isMainlineLog(log)
}

/** Group consecutive non-mainline logs into execution-detail segments */
function groupExecutionDetails(logs: LogEntry[]): RenderItem[] {
  const visibleLogs = logs.filter((log) => !shouldSkipProjectedLog(log))
  const items: RenderItem[] = []
  let i = 0

  while (i < visibleLogs.length) {
    const log = visibleLogs[i]

    if (isExecutionDetailLog(log)) {
      const group: LogEntry[] = [log]
      let j = i + 1

      while (j < visibleLogs.length) {
        const next = visibleLogs[j]
        if (isExecutionDetailLog(next)) {
          group.push(next)
          j++
        } else {
          break
        }
      }

      items.push({ kind: 'execution-group', logs: group, key: group[0].id })
      i = j
    } else {
      items.push({ kind: 'single', log, key: log.id })
      i++
    }
  }

  return items
}

function splitConversationTurns(logs: LogEntry[]): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  let user: LogEntry | undefined
  let agentLogs: LogEntry[] = []

  const pushTurn = () => {
    if (!user && agentLogs.length === 0) return
    turns.push({
      key: user ? `turn-${user.id}` : `turn-${agentLogs[0]?.id ?? turns.length}`,
      user,
      agentLogs,
    })
  }

  for (const log of logs) {
    if (log.type === LogType.User) {
      pushTurn()
      user = log
      agentLogs = []
    } else {
      agentLogs.push(log)
    }
  }
  pushTurn()

  return turns
}

function findFinalResponseIndex(logs: LogEntry[]): number {
  let fallbackErrorIndex = -1

  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const log = logs[index]
    if (!log.content.trim()) continue
    if (log.type === LogType.Assistant) return index
    if (fallbackErrorIndex === -1 && log.type === LogType.Error) {
      fallbackErrorIndex = index
    }
  }

  return fallbackErrorIndex
}

function formatDuration(startedAt?: number, endedAt?: number | null): string | null {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return null
  const durationMs = Math.max(0, (endedAt as number) - (startedAt as number))
  const totalSeconds = durationMs === 0 ? 0 : Math.max(1, Math.round(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`
  if (minutes > 0) return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ''}`
  return `${seconds}s`
}

function getTurnDuration(turn: ConversationTurn, completedAt?: number | null): string | null {
  const persistedProcessingStartedAt = turn.agentLogs.reduce<number | undefined>((latest, log) => (
    Number.isFinite(log.cursorActivity?.processingStartedAt)
      ? log.cursorActivity?.processingStartedAt
      : latest
  ), undefined)
  const startedAt = turn.user?.timestamp
    ?? persistedProcessingStartedAt
    ?? turn.agentLogs.find((log) => Number.isFinite(log.timestamp))?.timestamp
  const latestLogAt = turn.agentLogs.reduce<number | undefined>((latest, log) => {
    if (!Number.isFinite(log.timestamp)) return latest
    return latest === undefined ? log.timestamp : Math.max(latest, log.timestamp as number)
  }, undefined)

  return formatDuration(startedAt, completedAt ?? latestLogAt)
}

// ============ Components ============

const MarkdownMessage = memo(({
  content,
  className,
  workingDir,
  onOpenWorkspaceFile,
  onOpenPreviewUrl,
}: {
  content: string
  className?: string
  workingDir?: string
  onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void
  onOpenPreviewUrl?: OpenPreviewUrlHandler
}) => {
  const mermaidPlugins = useStreamdownMermaidPlugins(content)
  const components = useMemo(
    () => createMessageStreamdownComponents({ workingDir, onOpenWorkspaceFile, onOpenPreviewUrl }),
    [onOpenPreviewUrl, onOpenWorkspaceFile, workingDir],
  )

  return (
    <Streamdown
      className={cn('session-log-message-markdown', className)}
      components={components}
      plugins={mermaidPlugins}
      controls={mermaidPlugins ? streamdownMermaidControls : undefined}
    >
      {content}
    </Streamdown>
  )
})
MarkdownMessage.displayName = 'MarkdownMessage'

// 1. User Message — 右对齐聊天气泡
const UserMessage = memo(({ content, compact, workingDir, onOpenWorkspaceFile, onOpenPreviewUrl }: { content: string; compact?: boolean; workingDir?: string; onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void; onOpenPreviewUrl?: OpenPreviewUrlHandler }) => (
  <div className={compact ? 'flex justify-end mb-4 mt-2' : 'flex justify-end mb-8 mt-4'}>
    <div className={`relative bg-neutral-200 text-neutral-900 rounded-2xl rounded-tr-sm max-w-[85%] min-w-0 leading-relaxed ${
      compact ? 'px-3.5 py-2.5 text-[13px]' : 'px-5 py-3.5 text-sm'
    }`}>
      <MarkdownMessage content={content} workingDir={workingDir} onOpenWorkspaceFile={onOpenWorkspaceFile} onOpenPreviewUrl={onOpenPreviewUrl} />
    </div>
  </div>
))
UserMessage.displayName = 'UserMessage'

// 2. Thinking — 沉浸式折叠区块，视觉降权但内容可达
const ThinkingBlock = memo(({ content, isOpenDefault = true }: { content: string; isOpenDefault?: boolean }) => {
  const [isOpen, setIsOpen] = useState(isOpenDefault)
  const contentRef = useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = useState(0)

  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight)
    }
  }, [content, isOpen])

  // 截取前 80 字符作为摘要预览
  const preview = useMemo(() => {
    const trimmed = content.replace(/^Thinking:\s*/i, '').trim()
    const firstLine = trimmed.split('\n')[0] || ''
    return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine
  }, [content])

  return (
    <div className="my-1.5">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="group flex items-center gap-1.5 py-1 text-xs text-neutral-400 hover:text-neutral-500 transition-colors select-none w-full text-left"
      >
        <span className="shrink-0 w-3.5 h-3.5 flex items-center justify-center transition-transform duration-200" style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          <ChevronRight size={11} strokeWidth={2} />
        </span>
        <span className="font-medium">Thinking</span>
        {!isOpen && preview && (
          <span className="truncate text-neutral-300 ml-1 font-normal">{preview}</span>
        )}
      </button>

      <div
        className="overflow-hidden relative"
        style={{ maxHeight: isOpen ? contentHeight + 16 : 0 }}
      >
        <div ref={contentRef} className="pl-5 pt-1 pb-2 before:absolute before:left-[7px] before:top-1 before:bottom-2 before:w-px before:bg-neutral-100">
          <div className="text-xs text-neutral-400 leading-relaxed whitespace-pre-wrap min-w-0">
            {content.replace(/^Thinking:\s*/i, '').trim()}
          </div>
        </div>
      </div>
    </div>
  )
})
ThinkingBlock.displayName = 'ThinkingBlock'

// 3. Tool / Action — 内联文本样式，去除边框噪音
const ToolBlock = memo(({ title, content, type }: { title: string; content: string; type: LogType }) => {
  const [isOpen, setIsOpen] = useState(false)
  const isAction = type === LogType.Action

  // Action: 极简内联文本
  if (isAction) {
    return (
      <div className="flex items-center gap-1.5 py-0.5 text-xs text-neutral-400">
        <span className="shrink-0 w-1 h-1 rounded-full bg-neutral-300" />
        <span>{content}</span>
      </div>
    )
  }

  // 从 title 中提取状态
  const isSuccess = title.endsWith('✓')
  const isFailed = title.endsWith('✗')
  const statusColor = isFailed ? 'text-red-400' : isSuccess ? 'text-emerald-400' : 'text-neutral-400'

  // 提取首行摘要
  const firstLine = content?.split('\n')[0] || ''
  const summary = firstLine !== title ? firstLine : ''

  return (
    <div className="my-2">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="group flex items-center gap-1.5 py-1 text-xs w-full text-left transition-colors"
      >
        <span className={`shrink-0 w-3.5 h-3.5 flex items-center justify-center ${statusColor}`}>
          {isFailed ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          ) : isSuccess ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5.5l2 2 4-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          ) : (
            <span className="w-1 h-1 rounded-full bg-neutral-300" />
          )}
        </span>
        <span className="font-medium text-neutral-500 shrink-0">{title.replace(/\s*[✓✗]$/, '')}</span>
        {summary && (
          <span className="truncate text-neutral-300 font-mono">{summary}</span>
        )}
        {content && (
          <span className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-neutral-300">
            {isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </span>
        )}
      </button>

      {isOpen && content && (
        <div className="ml-5 mt-0.5 mb-1.5 rounded-md bg-neutral-50 border border-neutral-100 overflow-x-auto">
          <code className="block p-2.5 text-[11px] font-mono text-neutral-500 leading-relaxed whitespace-pre-wrap break-all">
            {content}
          </code>
        </div>
      )}
    </div>
  )
})
ToolBlock.displayName = 'ToolBlock'

// 3b. Tool Calls — 非主线事件折叠组
const ExecutionDetailsGroup = memo(({ logs }: { logs: LogEntry[] }) => {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(false)

  // 提取文件名摘要
  const summaries = logs.map((log) => {
    const firstLine = log.content.split('\n')[0] || ''
    const pathMatch = firstLine.match(/([^/\\]+\.[a-zA-Z0-9]+)/)
    return pathMatch ? pathMatch[1] : firstLine.slice(0, 40)
  })

  const detailCount = logs.length

  return (
    <div className="my-2">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="group flex items-center gap-1.5 py-1 text-xs w-full text-left transition-colors"
      >
        <span className="shrink-0 w-3.5 h-3.5 flex items-center justify-center transition-transform duration-200" style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          <ChevronRight size={11} strokeWidth={2} className="text-neutral-400" />
        </span>
        <span className="font-medium text-neutral-500 shrink-0">{t('工具调用')}</span>
        <span className="shrink-0 inline-flex items-center gap-1">
          <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-neutral-100 text-neutral-400 text-[10px] font-medium leading-none tabular-nums">
            {detailCount}
          </span>
        </span>
        {!isOpen && (
          <span className="truncate text-neutral-300 font-mono">
            {summaries.slice(0, 3).join(', ')}{logs.length > 3 ? ' …' : ''}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="ml-5 mt-0.5 mb-1.5">
          {logs.map((log) => {
            const firstLine = log.content.split('\n')[0] || ''
            return (
              <ToolGroupItem key={log.id} log={log} firstLine={firstLine} />
            )
          })}
        </div>
      )}
    </div>
  )
})
ExecutionDetailsGroup.displayName = 'ExecutionDetailsGroup'

/** Single item inside a ToolGroup — expandable for full content */
const ToolGroupItem = memo(({ log, firstLine }: { log: LogEntry; firstLine: string }) => {
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const hasMultiLineContent = log.content.includes('\n')

  const isSuccess = isToolSuccess(log)
  const isFailed = isToolFailure(log) || log.type === LogType.Error

  return (
    <div>
      <button
        onClick={() => hasMultiLineContent && setIsDetailOpen(!isDetailOpen)}
        className={`group flex items-center gap-1.5 py-0.5 text-xs w-full text-left ${
          hasMultiLineContent ? 'cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className="shrink-0 w-3.5 h-3.5 flex items-center justify-center">
          {isFailed ? (
            <svg width="8" height="8" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2l-6 6" stroke="rgb(248 113 113)" strokeWidth="1.5" strokeLinecap="round"/></svg>
          ) : isSuccess ? (
            <svg width="8" height="8" viewBox="0 0 10 10" fill="none"><path d="M2 5.5l2 2 4-4.5" stroke="rgb(52 211 153)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          ) : (
            <span className="w-1 h-1 rounded-full bg-neutral-300" />
          )}
        </span>
        <span className="truncate text-neutral-400 font-mono">{firstLine}</span>
        {hasMultiLineContent && (
          <span className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-neutral-300">
            {isDetailOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </span>
        )}
      </button>
      {isDetailOpen && (
        <div className="ml-5 mt-0.5 mb-1 rounded-md bg-neutral-50 border border-neutral-100 overflow-x-auto">
          <code className="block p-2.5 text-[11px] font-mono text-neutral-500 leading-relaxed whitespace-pre-wrap break-all">
            {log.content}
          </code>
        </div>
      )}
    </div>
  )
})
ToolGroupItem.displayName = 'ToolGroupItem'

// 4. Agent 主文本 — 纯文本无图标
const AgentText = memo(({ content, compact }: { content: string; compact?: boolean }) => (
  <div className={`text-neutral-900 whitespace-pre-wrap min-w-0 ${compact ? 'text-[13px] leading-5' : 'text-sm leading-6'}`}>
    {content}
  </div>
))
AgentText.displayName = 'AgentText'

// 5. Assistant Message — Streamdown 渲染 markdown
const AssistantMessage = memo(({ content, compact, workingDir, onOpenWorkspaceFile, onOpenPreviewUrl }: { content: string; compact?: boolean; workingDir?: string; onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void; onOpenPreviewUrl?: OpenPreviewUrlHandler }) => (
  <div className={`text-neutral-900 min-w-0 ${compact ? 'text-[13px] leading-5' : 'text-sm leading-6'}`}>
    <MarkdownMessage className="space-y-2" content={content} workingDir={workingDir} onOpenWorkspaceFile={onOpenWorkspaceFile} onOpenPreviewUrl={onOpenPreviewUrl} />
  </div>
))
AssistantMessage.displayName = 'AssistantMessage'

// 6. Error Message — 醒目的红色错误区块
const ErrorMessage = memo(({ content }: { content: string }) => (
  <div className="my-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
    <div className="flex items-start gap-2">
      <svg className="shrink-0 mt-0.5 w-4 h-4 text-red-500" viewBox="0 0 16 16" fill="currentColor">
        <path fillRule="evenodd" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM7.25 5a.75.75 0 011.5 0v3a.75.75 0 01-1.5 0V5zm.75 6.25a.75.75 0 100-1.5.75.75 0 000 1.5z" clipRule="evenodd" />
      </svg>
      <pre className="text-xs text-red-700 leading-relaxed whitespace-pre-wrap break-all min-w-0">{content}</pre>
    </div>
  </div>
))
ErrorMessage.displayName = 'ErrorMessage'

const ProcessedGroup = memo(({
  logs,
  duration,
  collapsible,
  onBeforeToggle,
  workingDir,
  onOpenWorkspaceFile,
  onOpenPreviewUrl,
}: {
  logs: LogEntry[]
  duration: string | null
  collapsible: boolean
  onBeforeToggle?: () => void
  workingDir?: string
  onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void
  onOpenPreviewUrl?: OpenPreviewUrlHandler
}) => {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(false)
  const label = duration
    ? t('已处理 {duration}', { duration })
    : t('已处理')
  const summaryContent = (
    <>
      <span>{label}</span>
      {collapsible && (
        <span
          className="flex size-4 shrink-0 items-center justify-center transition-transform duration-200 motion-reduce:transition-none"
          style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          <ChevronRight size={14} strokeWidth={2} />
        </span>
      )}
    </>
  )

  return (
    <div className="mb-3 mt-1">
      {collapsible ? (
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => {
            onBeforeToggle?.()
            setIsOpen((open) => !open)
          }}
          className="group flex w-full items-center gap-1.5 border-b border-neutral-100 py-2 text-left text-sm leading-6 text-neutral-500 transition-colors hover:text-neutral-700"
        >
          {summaryContent}
        </button>
      ) : (
        <div
          role="status"
          className="flex w-full items-center gap-1.5 border-b border-neutral-100 py-2 text-sm leading-6 text-neutral-500"
        >
          {summaryContent}
        </div>
      )}

      {collapsible && (
        <div
          data-processed-content
          aria-hidden={!isOpen}
          inert={!isOpen}
          className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
            isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="pb-1 pt-2">
              {renderLogItems(logs, workingDir, onOpenWorkspaceFile, onOpenPreviewUrl)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
ProcessedGroup.displayName = 'ProcessedGroup'

type Translate = (source: string, values?: Record<string, string | number | boolean | null | undefined>) => string

function formatActivityDuration(durationMs: number, t: Translate): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  if (totalSeconds < 60) return t('{count} 秒', { count: totalSeconds })

  const totalMinutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (totalMinutes < 60) return t('{minutes} 分 {seconds} 秒', { minutes: totalMinutes, seconds })

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return t('{hours} 小时 {minutes} 分', { hours, minutes })
}

const ThinkingIndicator = memo(({ activity }: { activity?: LogEntry['cursorActivity'] }) => {
  const { t } = useI18n()
  const mountedAtRef = useRef(Date.now())
  const [now, setNow] = useState(() => Date.now())
  const processingStartedAt = activity?.processingStartedAt ?? mountedAtRef.current

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const processingDuration = formatActivityDuration(now - processingStartedAt, t)
  const lastOutputDuration = activity?.lastOutputAt == null
    ? null
    : formatActivityDuration(now - activity.lastOutputAt, t)
  const label = t('正在思考')

  return (
    <Tooltip
      align="start"
      content={(
        <div className="flex min-w-max flex-col gap-0.5">
          <span>{t('已处理 {duration}', { duration: processingDuration })}</span>
          <span className="text-neutral-300">
            {lastOutputDuration
              ? t('最后一次输出于 {duration}前', { duration: lastOutputDuration })
              : t('等待首次输出')}
          </span>
        </div>
      )}
    >
      <span
        tabIndex={0}
        aria-label={label}
        className="inline-flex cursor-help select-none py-1 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="agent-thinking-shimmer" aria-hidden="true">
          {Array.from(label).map((character, index) => (
            <span
              key={`${character}-${index}`}
              className="agent-thinking-char"
              style={{ animationDelay: `${index * 45}ms` }}
            >
              {character}
            </span>
          ))}
        </span>
      </span>
    </Tooltip>
  )
})
ThinkingIndicator.displayName = 'ThinkingIndicator'

// ============ RenderItem renderer ============

function renderItem(
  item: RenderItem,
  compact?: boolean,
  workingDir?: string,
  onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void,
  onOpenPreviewUrl?: OpenPreviewUrlHandler,
): React.ReactNode {
  if (item.kind === 'execution-group') {
    return <ExecutionDetailsGroup logs={item.logs} />
  }

  const log = item.log

  if (log.type === LogType.Tool && log.children?.length) {
    return <ExecutionDetailsGroup logs={log.children} />
  }

  // 跳过空内容的条目，避免空 div 占据间距
  if (shouldSkipProjectedLog(log)) return null

  // 先识别 Thinking 类型（通过 title 或 content 前缀）
  if (log.title === 'Thinking' || log.content.startsWith('Thinking:')) {
    return <ThinkingBlock content={log.content} isOpenDefault={true} />
  }

  switch (log.type) {
    case LogType.User:
      return <UserMessage content={log.content} compact={compact} workingDir={workingDir} onOpenWorkspaceFile={onOpenWorkspaceFile} onOpenPreviewUrl={onOpenPreviewUrl} />

    case LogType.Tool:
      return <ToolBlock type={log.type} title={log.title || 'Tool'} content={log.content} />

    case LogType.Action:
      return <ToolBlock type={log.type} title="Action" content={log.content} />

    case LogType.Assistant:
      return <AssistantMessage content={log.content} compact={compact} workingDir={workingDir} onOpenWorkspaceFile={onOpenWorkspaceFile} onOpenPreviewUrl={onOpenPreviewUrl} />

    case LogType.Info:
            // 跳过 token_usage_info 条目的文本渲染（已由 TokenUsageIndicator 聚合展示）
            if (log.tokenUsage) return null
      return <AgentText content={log.content} compact={compact} />

    case LogType.Error:
      return <ErrorMessage content={log.content} />

    case LogType.Cursor:
      return <ThinkingIndicator activity={log.cursorActivity} />

    default:
      return null
  }
}

function renderLogItems(
  logs: LogEntry[],
  workingDir?: string,
  onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void,
  onOpenPreviewUrl?: OpenPreviewUrlHandler,
): React.ReactNode {
  return groupExecutionDetails(logs).map((item) => {
    const node = renderItem(item, false, workingDir, onOpenWorkspaceFile, onOpenPreviewUrl)
    return node ? <div key={item.key}>{node}</div> : null
  })
}

function renderConversationTurn(
  turn: ConversationTurn,
  isCompleted: boolean,
  completedAt: number | null | undefined,
  onUserToggleDetails?: () => void,
  workingDir?: string,
  onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void,
  onOpenPreviewUrl?: OpenPreviewUrlHandler,
): React.ReactNode {
  const userNode = turn.user
    ? renderLogItems([turn.user], workingDir, onOpenWorkspaceFile, onOpenPreviewUrl)
    : null

  if (!isCompleted) {
    return (
      <>
        {userNode}
        <ProcessedGroup
          logs={[]}
          duration={getTurnDuration(turn, completedAt)}
          collapsible={false}
        />
        {renderLogItems(turn.agentLogs, workingDir, onOpenWorkspaceFile, onOpenPreviewUrl)}
      </>
    )
  }

  if (turn.agentLogs.length === 0) return userNode

  const finalResponseIndex = findFinalResponseIndex(turn.agentLogs)
  const processedLogs = finalResponseIndex >= 0
    ? turn.agentLogs.slice(0, finalResponseIndex)
    : turn.agentLogs
  const finalLogs = finalResponseIndex >= 0
    ? turn.agentLogs.slice(finalResponseIndex)
    : []
  const hasProcessedContent = processedLogs.some((log) => !shouldSkipProjectedLog(log))

  return (
    <>
      {userNode}
      <ProcessedGroup
        logs={processedLogs}
        duration={getTurnDuration(turn, completedAt)}
        collapsible={hasProcessedContent}
        onBeforeToggle={onUserToggleDetails}
        workingDir={workingDir}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        onOpenPreviewUrl={onOpenPreviewUrl}
      />
      {renderLogItems(finalLogs, workingDir, onOpenWorkspaceFile, onOpenPreviewUrl)}
    </>
  )
}

// ============ Main Component ============

export const LogStream = forwardRef<LogStreamHandle, LogStreamProps>(
  function LogStream({ logs, isOutputActive, lastExitAt, onUserToggleDetails, scrollElementRef, workingDir, onOpenWorkspaceFile, onOpenPreviewUrl }, ref) {
    const turns = useMemo(() => (
      isOutputActive === undefined ? null : splitConversationTurns(logs)
    ), [isOutputActive, logs])
    const [liveNow, setLiveNow] = useState(() => Date.now())

    useEffect(() => {
      if (!isOutputActive) return
      const updateNow = () => setLiveNow(Date.now())
      const initialTimer = window.setTimeout(updateNow, 0)
      const interval = window.setInterval(updateNow, 1000)
      return () => {
        window.clearTimeout(initialTimer)
        window.clearInterval(interval)
      }
    }, [isOutputActive])

    // 暴露 scrollToBottom 给父组件（仅在传入 scrollElementRef 时有效）
    useImperativeHandle(ref, () => ({
      scrollToBottom: (behavior: 'instant' | 'smooth' = 'instant') => {
        if (!scrollElementRef?.current) return
        scrollElementRef.current.scrollTo({
          top: scrollElementRef.current.scrollHeight,
          behavior: behavior as ScrollBehavior,
        })
      },
    }), [scrollElementRef])

    return (
      <div className="w-full mx-auto pb-4 min-w-0" style={{ overflowWrap: 'anywhere' }}>
        {turns
          ? turns.map((turn, index) => (
              <div key={turn.key}>
                {renderConversationTurn(
                  turn,
                  index < turns.length - 1 || !isOutputActive,
                  index === turns.length - 1
                    ? (isOutputActive ? liveNow : lastExitAt)
                    : undefined,
                  onUserToggleDetails,
                  workingDir,
                  onOpenWorkspaceFile,
                  onOpenPreviewUrl,
                )}
              </div>
            ))
          : renderLogItems(logs, workingDir, onOpenWorkspaceFile, onOpenPreviewUrl)}
      </div>
    )
  },
)
