import { useState, useMemo, useCallback, useImperativeHandle, forwardRef, memo, useRef, useEffect } from 'react'
import { type LogEntry, LogType } from '@agent-tower/shared/log-adapter'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { Streamdown } from 'streamdown'
import { useVirtualizer } from '@tanstack/react-virtual'
import 'streamdown/styles.css'

interface LogStreamProps {
  logs: LogEntry[]
  /** 外部滚动容器 ref，virtualizer 需要它来计算可视区域 */
  scrollElementRef: React.RefObject<HTMLDivElement | null>
  /** scrollMargin: 滚动容器顶部到 LogStream 之间的偏移量（如 task description 高度） */
  scrollMargin?: number
}

export interface LogStreamHandle {
  scrollToBottom: (behavior?: 'instant' | 'smooth') => void
}

// ============ Grouping Logic ============

/** Extract the base tool label without status suffixes like ✓ ✗ */
function toolBaseLabel(title: string): string {
  return title.replace(/\s*[✓✗]$/, '').replace(/\s*\(.*\)$/, '').trim()
}

type RenderItem =
  | { kind: 'single'; log: LogEntry; key: string }
  | { kind: 'group'; label: string; logs: LogEntry[]; key: string }

/** Group consecutive Tool entries with the same base label into collapsed groups */
function groupConsecutiveTools(logs: LogEntry[]): RenderItem[] {
  const items: RenderItem[] = []
  let i = 0

  while (i < logs.length) {
    const log = logs[i]

    // Only group Tool type entries
    if (log.type === LogType.Tool && log.title) {
      const baseLabel = toolBaseLabel(log.title)
      const group: LogEntry[] = [log]
      let j = i + 1

      // Collect consecutive tools with the same base label
      while (j < logs.length) {
        const next = logs[j]
        if (next.type === LogType.Tool && next.title && toolBaseLabel(next.title) === baseLabel) {
          group.push(next)
          j++
        } else {
          break
        }
      }

      if (group.length >= 2) {
        // 2+ consecutive same-type tools → collapse into a group
        items.push({ kind: 'group', label: baseLabel, logs: group, key: group[0].id })
      } else {
        // 1-2 items, render individually
        for (const g of group) {
          items.push({ kind: 'single', log: g, key: g.id })
        }
      }
      i = j
    } else {
      items.push({ kind: 'single', log, key: log.id })
      i++
    }
  }

  return items
}

// ============ Components ============

// 1. User Message — 右对齐聊天气泡
const UserMessage = memo(({ content }: { content: string }) => (
  <div className="flex justify-end mb-8 mt-4">
    <div className="relative bg-neutral-200 text-neutral-900 px-5 py-3.5 rounded-2xl rounded-tr-sm max-w-[85%] text-sm leading-relaxed whitespace-pre-wrap">
      {content}
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
          <div className="text-xs text-neutral-400 leading-relaxed whitespace-pre-wrap">
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
    <div className="my-0.5">
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

// 3b. Tool Group — 紧凑的折叠分组
const ToolGroup = memo(({ label, logs }: { label: string; logs: LogEntry[] }) => {
  const [isOpen, setIsOpen] = useState(false)

  // 提取文件名摘要
  const summaries = logs.map((log) => {
    const firstLine = log.content.split('\n')[0] || ''
    const pathMatch = firstLine.match(/([^/\\]+\.[a-zA-Z0-9]+)/)
    return pathMatch ? pathMatch[1] : firstLine.slice(0, 40)
  })

  // 统计成功/失败
  const successCount = logs.filter(l => l.title?.endsWith('✓')).length
  const failCount = logs.filter(l => l.title?.endsWith('✗')).length

  return (
    <div className="my-0.5">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="group flex items-center gap-1.5 py-1 text-xs w-full text-left transition-colors"
      >
        <span className="shrink-0 w-3.5 h-3.5 flex items-center justify-center transition-transform duration-200" style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          <ChevronRight size={11} strokeWidth={2} className="text-neutral-400" />
        </span>
        <span className="font-medium text-neutral-500 shrink-0">{label}</span>
        <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-neutral-100 text-neutral-400 text-[10px] font-medium leading-none shrink-0 tabular-nums">
          {logs.length}
        </span>
        {successCount > 0 && (
          <span className="text-emerald-400 text-[10px]">{successCount}✓</span>
        )}
        {failCount > 0 && (
          <span className="text-red-400 text-[10px]">{failCount}✗</span>
        )}
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
ToolGroup.displayName = 'ToolGroup'

/** Single item inside a ToolGroup — expandable for full content */
const ToolGroupItem = memo(({ log, firstLine }: { log: LogEntry; firstLine: string }) => {
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const hasMultiLineContent = log.content.includes('\n')

  const isSuccess = log.title?.endsWith('✓')
  const isFailed = log.title?.endsWith('✗')

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
const AgentText = memo(({ content }: { content: string }) => (
  <div className="text-sm text-neutral-800 leading-7 mb-2 whitespace-pre-wrap">
    {content}
  </div>
))
AgentText.displayName = 'AgentText'

// 5. Assistant Message — Streamdown 渲染 markdown
const AssistantMessage = memo(({ content }: { content: string }) => (
  <div className="text-sm text-neutral-800 leading-7 mb-2">
    <Streamdown>{content}</Streamdown>
  </div>
))
AssistantMessage.displayName = 'AssistantMessage'

// ============ RenderItem renderer ============

function renderItem(item: RenderItem): React.ReactNode {
  if (item.kind === 'group') {
    return <ToolGroup label={item.label} logs={item.logs} />
  }

  const log = item.log

  // 跳过空内容的条目，避免空 div 占据间距
  if (!log.content && log.type !== LogType.Cursor) return null

  // 先识别 Thinking 类型（通过 title 或 content 前缀）
  if (log.title === 'Thinking' || log.content.startsWith('Thinking:')) {
    return <ThinkingBlock content={log.content} isOpenDefault={true} />
  }

  switch (log.type) {
    case LogType.User:
      return <UserMessage content={log.content} />

    case LogType.Tool:
      return <ToolBlock type={log.type} title={log.title || 'Tool'} content={log.content} />

    case LogType.Action:
      return <ToolBlock type={log.type} title="Action" content={log.content} />

    case LogType.Assistant:
      return <AssistantMessage content={log.content} />

    case LogType.Info:
            // 跳过 token_usage_info 条目的文本渲染（已由 TokenUsageIndicator 聚合展示）
            if (log.tokenUsage) return null
      return <AgentText content={log.content} />

    case LogType.Cursor:
      return (
        <div className="h-4 w-1.5 bg-neutral-400 animate-pulse rounded-sm mt-1 inline-block align-middle" />
      )

    default:
      return null
  }
}

// ============ Main Component ============

export const LogStream = forwardRef<LogStreamHandle, LogStreamProps>(
  function LogStream({ logs, scrollElementRef, scrollMargin = 0 }, ref) {
    const items = useMemo(() => groupConsecutiveTools(logs), [logs])

    const virtualizer = useVirtualizer({
      count: items.length,
      getScrollElement: () => scrollElementRef.current,
      estimateSize: () => 60,
      overscan: 10,
      scrollMargin,
    })

    // 暴露 scrollToBottom 给父组件
    useImperativeHandle(ref, () => ({
      scrollToBottom: (behavior: 'instant' | 'smooth' = 'instant') => {
        if (items.length === 0) return
        virtualizer.scrollToIndex(items.length - 1, {
          align: 'end',
          behavior: behavior as any,
        })
      },
    }), [items.length, virtualizer])

    // 动态测量回调
    const measureElement = useCallback(
      (el: HTMLElement | null) => {
        if (el) {
          virtualizer.measureElement(el)
        }
      },
      [virtualizer],
    )

    const virtualItems = virtualizer.getVirtualItems()

    return (
      <div
        className="w-full mx-auto pb-4 relative"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualItems.map((virtualRow) => {
          const item = items[virtualRow.index]
          return (
            <div
              key={item.key}
              ref={measureElement}
              data-index={virtualRow.index}
              className="absolute left-0 w-full"
              style={{
                top: virtualRow.start - virtualizer.options.scrollMargin,
              }}
            >
              {renderItem(item)}
            </div>
          )
        })}
      </div>
    )
  },
)
