import React, { useState, useCallback } from "react"
import { Code2, Terminal, Globe, GitGraph, Plus, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { TerminalView } from "./TerminalView"
import { EditorView } from "./EditorView"
import {
  useTerminalManager,
  type TerminalTab,
} from "@/lib/socket/hooks/useTerminal"

// ============================================================
// Types
// ============================================================

/** Git 文件变更状态 */
export type FileChangeStatus = "M" | "A" | "D" | "U" | "R"

/** 单个文件变更条目 */
export interface FileChange {
  /** 文件路径 */
  path: string
  /** 变更状态: M=Modified, A=Added, D=Deleted, U=Untracked, R=Renamed */
  status: FileChangeStatus
}

type WorkspaceTab = "editor" | "terminal" | "preview" | "changes"

export interface WorkspacePanelProps {
  /** 文件变更列表 */
  changes?: FileChange[]
  /** 当前分支名 */
  branch?: string
  /** 自定义类名 */
  className?: string
  /** Session ID 用于 Agent 终端 Tab 接入 PTY */
  sessionId?: string
  /** 工作目录 — 独立终端创建 PTY 时使用 */
  workingDir?: string
}

// ============================================================
// Tab 配置
// ============================================================

interface TabConfig {
  key: WorkspaceTab
  label: string
  icon: React.ReactNode
}

const TABS: TabConfig[] = [
  { key: "editor", label: "Editor", icon: <Code2 size={14} /> },
  { key: "terminal", label: "Terminal", icon: <Terminal size={14} /> },
  { key: "preview", label: "Preview", icon: <Globe size={14} /> },
  { key: "changes", label: "Changes", icon: <GitGraph size={14} /> },
]

// ============================================================
// Mock 数据
// ============================================================

const MOCK_CHANGES: FileChange[] = [
  { path: "src/auth/Login.tsx", status: "M" },
  { path: "src/components/Button.tsx", status: "M" },
  { path: "src/utils/validation.ts", status: "U" },
  { path: "src/services/api.ts", status: "A" },
  { path: "package.json", status: "M" },
  { path: "src/styles/legacy.css", status: "D" },
]

const MOCK_BRANCH = "feat/workspace-panel"

// ============================================================
// 状态颜色映射
// ============================================================

const STATUS_COLOR_MAP: Record<FileChangeStatus, string> = {
  M: "text-amber-600 border-amber-200 bg-amber-50",
  A: "text-emerald-600 border-emerald-200 bg-emerald-50",
  D: "text-red-600 border-red-200 bg-red-50",
  U: "text-emerald-600 border-emerald-200 bg-emerald-50",
  R: "text-blue-600 border-blue-200 bg-blue-50",
}

const STATUS_LABEL_MAP: Record<FileChangeStatus, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  U: "Untracked",
  R: "Renamed",
}

// ============================================================
// 子组件
// ============================================================

/** Tab 按钮 — folder 风格 */
const TabButton: React.FC<{
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}> = ({ active, onClick, icon, label }) => (
  <button
    onClick={onClick}
    className={cn(
      "flex items-center gap-2 px-4 py-2 text-xs font-medium transition-all rounded-t-md border-t border-x -mb-px",
      active
        ? "bg-white border-neutral-200 text-neutral-900 shadow-[0_-2px_6px_rgba(0,0,0,0.02)] z-10"
        : "bg-transparent border-transparent text-neutral-500 hover:text-neutral-700 hover:bg-neutral-200/50"
    )}
  >
    {icon}
    <span>{label}</span>
  </button>
)

/** 文件变更条目 */
const FileItem: React.FC<{ name: string; status: FileChangeStatus }> = ({
  name,
  status,
}) => {
  const colorClass = STATUS_COLOR_MAP[status]
  const label = STATUS_LABEL_MAP[status]

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-neutral-50 rounded cursor-pointer group">
      <span
        className={cn(
          "w-4 h-4 flex items-center justify-center text-[10px] font-bold border rounded-sm shrink-0",
          colorClass
        )}
        title={label}
      >
        {status}
      </span>
      <span className="text-xs text-neutral-700 group-hover:text-neutral-900 truncate flex-1">
        {name}
      </span>
    </div>
  )
}

/** Coming Soon 占位面板 */
const ComingSoonPlaceholder: React.FC<{
  icon: React.ReactNode
  title: string
}> = ({ icon, title }) => (
  <div className="flex-1 flex items-center justify-center bg-white">
    <div className="flex flex-col items-center gap-2 text-neutral-400">
      {icon}
      <span className="text-sm font-medium text-neutral-500">{title}</span>
      <span className="text-xs">Coming soon...</span>
    </div>
  </div>
)

/** Changes Tab 内容 */
const ChangesView: React.FC<{
  changes: FileChange[]
  branch: string
}> = ({ changes, branch }) => {
  const changedCount = changes.filter(
    (c) => c.status === "M" || c.status === "A" || c.status === "R"
  ).length
  const untrackedCount = changes.filter((c) => c.status === "U").length
  const deletedCount = changes.filter((c) => c.status === "D").length

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Header */}
      <div className="px-4 py-3 border-b border-neutral-100 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <GitGraph size={16} className="text-neutral-500" />
            <h3 className="font-semibold text-neutral-900">Source Control</h3>
          </div>
          <div className="flex gap-2 items-center">
            <span className="text-xs bg-neutral-100 px-1.5 py-0.5 rounded text-neutral-500">
              {branch}
            </span>
          </div>
        </div>

        {/* Commit message input */}
        <div className="relative">
          <input
            type="text"
            placeholder="Message (Enter to commit)"
            className="w-full px-3 py-1.5 bg-neutral-50 border border-neutral-200 rounded text-xs focus:outline-none focus:border-neutral-400 transition-colors"
          />
        </div>
      </div>

      {/* File changes list */}
      <div className="flex-1 overflow-auto p-2">
        {/* Summary stats */}
        <div className="flex items-center gap-3 px-2 py-1.5 mb-1">
          <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
            Changes
          </span>
          <div className="flex gap-2 text-[10px]">
            {changedCount > 0 && (
              <span className="text-amber-600">{changedCount} modified</span>
            )}
            {untrackedCount > 0 && (
              <span className="text-emerald-600">
                {untrackedCount} untracked
              </span>
            )}
            {deletedCount > 0 && (
              <span className="text-red-600">{deletedCount} deleted</span>
            )}
          </div>
        </div>

        {/* File list */}
        {changes.length > 0 ? (
          <div className="space-y-0.5">
            {changes.map((file) => (
              <FileItem
                key={file.path}
                name={file.path}
                status={file.status}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-neutral-400">
            <GitGraph size={28} className="mb-2" />
            <span className="text-xs">No pending changes</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// Terminal Tab 内部组件 — 多终端管理
// ============================================================

/** 终端 Tab 按钮（深色风格） */
const TerminalTabButton: React.FC<{
  tab: TerminalTab
  active: boolean
  onClick: () => void
  onClose: (e: React.MouseEvent) => void
}> = ({ tab, active, onClick, onClose }) => (
  <button
    onClick={onClick}
    className={`group flex items-center gap-2 px-3 py-2 rounded-t-md min-w-[120px] max-w-[200px] border-t border-x ${
      active
        ? "bg-[#1e1e1e] border-[#1e1e1e] text-white"
        : "bg-[#2d2d2d] border-transparent text-neutral-500 hover:bg-[#333] hover:text-neutral-300"
    }`}
  >
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${
        tab.status === "running"
          ? "bg-emerald-500 animate-pulse"
          : tab.status === "creating"
            ? "bg-amber-500 animate-pulse"
            : "bg-neutral-500"
      }`}
    />
    <span className="truncate flex-1 text-left text-xs">{tab.title}</span>
    <span
      onClick={onClose}
      className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-neutral-700 rounded transition-all shrink-0"
    >
      <X size={10} />
    </span>
  </button>
)

/** Terminal Tab 区域整体 */
const TerminalTabContent: React.FC<{
  sessionId?: string
  workingDir?: string
}> = ({ sessionId, workingDir }) => {
  const {
    terminals,
    activeTerminalId,
    setActiveTerminalId,
    createTerminal,
    destroyTerminal,
  } = useTerminalManager()

  const handleAddTerminal = useCallback(() => {
    const dir = workingDir || "~"
    createTerminal(dir)
  }, [workingDir, createTerminal])

  const handleCloseTerminal = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      destroyTerminal(id)
    },
    [destroyTerminal]
  )

  // 是否有活跃的独立终端 tab
  const activeTab = terminals.find((t) => t.id === activeTerminalId)

  // 是否显示 Agent 终端（当没有独立终端 tab 被选中且有 sessionId 时）
  const showAgentTerminal = sessionId && !activeTab

  return (
    <div className="flex h-full flex-col bg-[#1e1e1e] text-neutral-200 font-mono text-xs animate-in fade-in duration-200">
      {/* Terminal Header/Tabs */}
      <div className="flex items-center bg-[#252526] border-b border-[#333] px-2 pt-2 gap-1 overflow-x-auto shrink-0">
        {/* Agent 终端 tab（如果有 sessionId） */}
        {sessionId && (
          <button
            onClick={() => setActiveTerminalId(null)}
            className={`group flex items-center gap-2 px-3 py-2 rounded-t-md min-w-[120px] max-w-[200px] border-t border-x ${
              !activeTab
                ? "bg-[#1e1e1e] border-[#1e1e1e] text-white"
                : "bg-[#2d2d2d] border-transparent text-neutral-500 hover:bg-[#333] hover:text-neutral-300"
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            <span className="truncate flex-1 text-left text-xs">Agent</span>
          </button>
        )}

        {/* 独立终端 tabs */}
        {terminals.map((t) => (
          <TerminalTabButton
            key={t.id}
            tab={t}
            active={activeTerminalId === t.id}
            onClick={() => setActiveTerminalId(t.id)}
            onClose={(e) => handleCloseTerminal(t.id, e)}
          />
        ))}

        {/* "+" 按钮 */}
        <button
          onClick={handleAddTerminal}
          className="p-1.5 mb-0.5 text-neutral-500 hover:text-neutral-300 hover:bg-[#333] rounded ml-1 shrink-0"
          title="Create new terminal"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Terminal Body */}
      <div className="flex-1 overflow-hidden">
        {showAgentTerminal ? (
          /* Agent 终端 */
          <TerminalView sessionId={sessionId} />
        ) : activeTab ? (
          /* 独立终端 — 使用 key 保证每个 tab 独立 xterm 实例 */
          <TerminalView key={activeTab.id} terminalId={activeTab.id} />
        ) : (
          /* 空状态 */
          <div className="flex-1 flex items-center justify-center text-neutral-600 flex-col gap-2 h-full">
            <Terminal size={32} />
            <span>No open terminals</span>
            <button
              onClick={handleAddTerminal}
              className="text-blue-400 hover:underline text-xs"
            >
              Create new terminal
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// 主组件
// ============================================================

export const WorkspacePanel: React.FC<WorkspacePanelProps> = React.memo(
  function WorkspacePanel({
    changes = MOCK_CHANGES,
    branch = MOCK_BRANCH,
    className,
    sessionId,
    workingDir,
  }) {
    const [activeTab, setActiveTab] = useState<WorkspaceTab>("terminal")

    return (
      <div className={cn("flex flex-col h-full bg-white", className)}>
        {/* Tab 栏 — folder style */}
        <div className="flex items-center px-2 pt-2 border-b border-neutral-200 bg-neutral-100/80 shrink-0 gap-1 select-none">
          {TABS.map((tab) => (
            <TabButton
              key={tab.key}
              active={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
              icon={tab.icon}
              label={tab.label}
            />
          ))}
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-hidden relative">
          {/* Editor Tab */}
          {activeTab === "editor" && (
            <EditorView workingDir={workingDir} />
          )}

          {/* Terminal Tab */}
          {activeTab === "terminal" && (
            <div className="h-full">
              <TerminalTabContent
                sessionId={sessionId}
                workingDir={workingDir}
              />
            </div>
          )}

          {/* Preview Tab */}
          {activeTab === "preview" && (
            <ComingSoonPlaceholder
              icon={<Globe size={32} />}
              title="Preview"
            />
          )}

          {/* Changes Tab */}
          {activeTab === "changes" && (
            <ChangesView changes={changes} branch={branch} />
          )}
        </div>
      </div>
    )
  }
)
