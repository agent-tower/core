import React, { useState, useRef, useEffect } from "react"
import { Code2, Terminal, Globe, GitGraph } from "lucide-react"

import { cn } from "@/lib/utils"
import { TerminalTabs } from "./TerminalTabs"
import { EditorView } from "./EditorView"
import { ChangesView } from "./ChangesView"

type WorkspaceTab = "editor" | "terminal" | "preview" | "changes"

export interface WorkspacePanelProps {
  /** 自定义类名 */
  className?: string
  /** Session ID 用于 Agent 终端 Tab 接入 PTY */
  sessionId?: string
  workingDir?: string
  /** 隐藏 Changes tab（移动端已有独立 Changes 视图时使用） */
  hideChanges?: boolean
}

// ============================================================
// Tab 配置
// ============================================================

interface TabConfig {
  key: WorkspaceTab
  label: string
  icon: React.ReactNode
}

const DESKTOP_TABS: TabConfig[] = [
  { key: "changes", label: "Changes", icon: <GitGraph size={14} /> },
  { key: "editor", label: "Editor", icon: <Code2 size={14} /> },
  { key: "terminal", label: "Terminal", icon: <Terminal size={14} /> },
  { key: "preview", label: "Preview", icon: <Globe size={14} /> },
]

const MOBILE_TABS: TabConfig[] = [
  { key: "editor", label: "Editor", icon: <Code2 size={14} /> },
  { key: "terminal", label: "Terminal", icon: <Terminal size={14} /> },
  { key: "preview", label: "Preview", icon: <Globe size={14} /> },
]

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

export const WorkspacePanel: React.FC<WorkspacePanelProps> = React.memo(
  function WorkspacePanel({
    className,
    sessionId: _sessionId,
    workingDir,
    hideChanges,
  }) {
    const tabs = hideChanges ? MOBILE_TABS : DESKTOP_TABS
    const [activeTab, setActiveTab] = useState<WorkspaceTab>(hideChanges ? "editor" : "changes")

    // Track all workingDirs that have been seen so each gets its own
    // TerminalTabs instance that stays mounted across task switches.
    const [terminalDirs, setTerminalDirs] = useState<string[]>([])
    const prevDirRef = useRef<string | undefined>(undefined)

    useEffect(() => {
      if (workingDir && workingDir !== prevDirRef.current) {
        prevDirRef.current = workingDir
        setTerminalDirs(prev => prev.includes(workingDir) ? prev : [...prev, workingDir])
      }
    }, [workingDir])

    return (
      <div className={cn("flex flex-col h-full bg-white", className)}>
        {/* Tab 栏 — folder style */}
        <div className="flex items-center px-2 pt-2 border-b border-neutral-200 bg-neutral-100/80 shrink-0 gap-1 select-none">
          {tabs.map((tab) => (
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

          {/* Terminal Tab — one TerminalTabs per workingDir, kept mounted */}
          {terminalDirs.map(dir => (
            <div
              key={dir}
              className="h-full absolute inset-0"
              style={{ display: activeTab === "terminal" && workingDir === dir ? 'block' : 'none' }}
            >
              <TerminalTabs cwd={dir} />
            </div>
          ))}

          {/* Preview Tab */}
          {activeTab === "preview" && (
            <ComingSoonPlaceholder
              icon={<Globe size={32} />}
              title="Preview"
            />
          )}

          {/* Changes Tab */}
          {activeTab === "changes" && (
            <ChangesView workingDir={workingDir} />
          )}
        </div>
      </div>
    )
  }
)
