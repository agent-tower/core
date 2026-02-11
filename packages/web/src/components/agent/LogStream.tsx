import { useState } from 'react'
import { type LogEntry, LogType } from '@agent-tower/shared/log-adapter'
import { Terminal, Brain, ChevronRight, ChevronDown } from 'lucide-react'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'

interface LogStreamProps {
  logs: LogEntry[]
}

// 1. User Message — 右对齐聊天气泡
const UserMessage = ({ content }: { content: string }) => (
  <div className="flex justify-end mb-8 mt-4">
    <div className="relative bg-neutral-200 text-neutral-900 px-5 py-3.5 rounded-2xl rounded-tr-sm max-w-[85%] text-sm leading-relaxed whitespace-pre-wrap">
      {content}
    </div>
  </div>
)

// 2. Thinking — 可折叠，默认收起，Brain 图标
const ThinkingBlock = ({ content, isOpenDefault = false }: { content: string; isOpenDefault?: boolean }) => {
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
            {content}
          </div>
        </div>
      )}
    </div>
  )
}

// 3. Tool / Action — pill 按钮或极简状态行
const ToolBlock = ({ title, content, type }: { title: string; content: string; type: LogType }) => {
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
}

// 4. Agent 主文本 — 纯文本无图标
const AgentText = ({ content }: { content: string }) => (
  <div className="text-sm text-neutral-800 leading-7 mb-4 whitespace-pre-wrap animate-in fade-in duration-500">
    {content}
  </div>
)

// 5. Assistant Message — Streamdown 渲染 markdown
const AssistantMessage = ({ content }: { content: string }) => (
  <div className="text-sm text-neutral-800 leading-7 mb-4 animate-in fade-in duration-500">
    <Streamdown>{content}</Streamdown>
  </div>
)

export function LogStream({ logs }: LogStreamProps) {
  return (
    <div className="flex flex-col w-full mx-auto pb-4">
      {logs.map((log) => {
        // 先识别 Thinking 类型（通过 title 或 content 前缀）
        if (log.title === 'Thinking' || log.content.startsWith('Thinking:')) {
          return <ThinkingBlock key={log.id} content={log.content} isOpenDefault={true} />
        }

        switch (log.type) {
          case LogType.User:
            return <UserMessage key={log.id} content={log.content} />

          case LogType.Tool:
            return <ToolBlock key={log.id} type={log.type} title={log.title || 'Tool'} content={log.content} />

          case LogType.Action:
            return <ToolBlock key={log.id} type={log.type} title="Action" content={log.content} />

          case LogType.Assistant:
            return <AssistantMessage key={log.id} content={log.content} />

          case LogType.Info:
            return <AgentText key={log.id} content={log.content} />

          case LogType.Cursor:
            return (
              <div key={log.id} className="h-4 w-2 bg-neutral-900 animate-pulse mt-1 inline-block align-middle" />
            )

          default:
            return null
        }
      })}
    </div>
  )
}
