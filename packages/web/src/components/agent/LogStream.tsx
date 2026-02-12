import { useState, useMemo, useCallback, useImperativeHandle, forwardRef, memo } from 'react'
import { type LogEntry, LogType } from '@agent-tower/shared/log-adapter'
import { Terminal, Brain, ChevronRight, ChevronDown, Files } from 'lucide-react'
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

// 2. Thinking — 可折叠，默认收起，Brain 图标
const ThinkingBlock = memo(({ content, isOpenDefault = false }: { content: string; isOpenDefault?: boolean }) => {
  const [isOpen, setIsOpen] = useState(isOpenDefault)

  return (
    <div className="mb-4">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 text-xs font-medium text-neutral-400 hover:text-neutral-600 transition-colors select-none"
      >
        <Brain size={12} />
        <span>Thinking Process</span>
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>

      {isOpen && (
        <div className="mt-2 pl-3 border-l-2 border-neutral-100">
          <div className="text-xs text-neutral-500 font-mono leading-relaxed whitespace-pre-wrap">
            {content.trim()}
          </div>
        </div>
      )}
    </div>
  )
})
ThinkingBlock.displayName = 'ThinkingBlock'

// 3. Tool / Action — pill 按钮或极简状态行
const ToolBlock = memo(({ title, content, type }: { title: string; content: string; type: LogType }) => {
  const [isOpen, setIsOpen] = useState(false)
  const isAction = type === LogType.Action

  // Action: 极简状态行 — 小圆点 + 浅色文字
  if (isAction) {
    return (
      <div className="flex items-center gap-2 py-1.5 text-xs text-neutral-400 animate-in fade-in slide-in-from-left-1 duration-300">
        <div className="w-1 h-1 rounded-full bg-neutral-300" />
        <span>{content}</span>
      </div>
    )
  }

  // Tool: pill 按钮 + 暗色代码展开区域
  return (
    <div className="mb-3 group">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-mono w-full text-left transition-all ${
          isOpen
            ? 'bg-neutral-50 border-neutral-200 text-neutral-700'
            : 'bg-white border-neutral-100 text-neutral-500 hover:border-neutral-200 hover:text-neutral-700'
        }`}
      >
        <Terminal size={12} className="opacity-70" />
        <span className="font-medium shrink-0">{title || 'System Operation'}</span>
        {content && content.split('\n')[0] !== title && (
          <span className="truncate text-neutral-400">— {content.split('\n')[0]}</span>
        )}
        <span className="opacity-0 group-hover:opacity-100 transition-opacity text-neutral-400">
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {isOpen && content && (
        <div className="mt-1 bg-neutral-900 rounded-lg p-3 overflow-x-auto">
          <code className="text-[11px] font-mono text-neutral-300 whitespace-pre-wrap break-all">
            {content}
          </code>
        </div>
      )}
    </div>
  )
})
ToolBlock.displayName = 'ToolBlock'

// 3b. Tool Group — collapsed group of consecutive same-type tool calls
const ToolGroup = memo(({ label, logs }: { label: string; logs: LogEntry[] }) => {
  const [isOpen, setIsOpen] = useState(false)

  // Extract short file/resource names from content for preview
  const summaries = logs.map((log) => {
    const firstLine = log.content.split('\n')[0] || ''
    // Try to extract just the filename from a path
    const pathMatch = firstLine.match(/([^/\\]+\.[a-zA-Z0-9]+)/)
    return pathMatch ? pathMatch[1] : firstLine.slice(0, 60)
  })

  return (
    <div className="mb-3">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-mono w-full text-left transition-all ${
          isOpen
            ? 'bg-neutral-50 border-neutral-200 text-neutral-700'
            : 'bg-white border-neutral-100 text-neutral-500 hover:border-neutral-200 hover:text-neutral-700'
        }`}
      >
        <Files size={12} className="opacity-70 shrink-0" />
        <span className="font-medium shrink-0">{label}</span>
        <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-500 text-[10px] font-semibold leading-none shrink-0">
          {logs.length}
        </span>
        {!isOpen && (
          <span className="truncate text-neutral-400">
            — {summaries.slice(0, 3).join(', ')}{logs.length > 3 ? ', …' : ''}
          </span>
        )}
        <span className="ml-auto text-neutral-400 shrink-0">
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {isOpen && (
        <div className="mt-1 border border-neutral-100 rounded-lg overflow-hidden divide-y divide-neutral-50">
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

  return (
    <div className="bg-white">
      <button
        onClick={() => hasMultiLineContent && setIsDetailOpen(!isDetailOpen)}
        className={`flex items-center gap-2 px-3 py-1.5 text-xs font-mono w-full text-left ${
          hasMultiLineContent ? 'hover:bg-neutral-50 cursor-pointer' : 'cursor-default'
        } text-neutral-500`}
      >
        <div className="w-1 h-1 rounded-full bg-neutral-300 shrink-0" />
        <span className="truncate">{firstLine}</span>
        {hasMultiLineContent && (
          <span className="ml-auto text-neutral-300 shrink-0">
            {isDetailOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </span>
        )}
      </button>
      {isDetailOpen && (
        <div className="mx-3 mb-2 bg-neutral-900 rounded-lg p-3 overflow-x-auto">
          <code className="text-[11px] font-mono text-neutral-300 whitespace-pre-wrap break-all">
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
  <div className="text-sm text-neutral-800 leading-7 mb-4 whitespace-pre-wrap animate-in fade-in duration-500">
    {content}
  </div>
))
AgentText.displayName = 'AgentText'

// 5. Assistant Message — Streamdown 渲染 markdown
const AssistantMessage = memo(({ content }: { content: string }) => (
  <div className="text-sm text-neutral-800 leading-7 mb-4 animate-in fade-in duration-500">
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
        <div className="h-4 w-2 bg-neutral-900 animate-pulse mt-1 inline-block align-middle" />
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
