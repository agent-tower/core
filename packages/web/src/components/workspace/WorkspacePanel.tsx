import React, { useState, useRef, useEffect, useMemo, useImperativeHandle } from "react"
import { Code2, Terminal, Globe, GitGraph, History, Users } from "lucide-react"
import type { TeamRun, Workspace } from "@agent-tower/shared"

import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n"
import { TerminalTabs } from "./TerminalTabs"
import { EditorView } from "./EditorView"
import { ChangesView } from "./ChangesView"
import { HistoryView } from "./HistoryView"
import { PreviewPanel } from "./PreviewPanel"
import { WorkspaceSwitcher } from "./WorkspaceSwitcher"
import { buildWorkspaceViews } from "./team-workspace-view"
import { useProject } from "@/hooks/use-projects"
import type { QuickCommand } from "@agent-tower/shared"

export type WorkspaceTab = "editor" | "terminal" | "preview" | "changes" | "history"
type WorkspaceTabWithTeam = WorkspaceTab | "team-status"

export interface WorkspacePanelProps {
  /** 自定义类名 */
  className?: string
  /** Session ID 用于 Agent 终端 Tab 接入 PTY */
  sessionId?: string
  workspaceId?: string
  workingDir?: string
  /** 项目 ID，用于获取快捷命令 */
  projectId?: string
  /** 隐藏 Changes tab（移动端已有独立 Changes 视图时使用） */
  hideChanges?: boolean
  readOnly?: boolean
  repoDeleted?: boolean
  teamRun?: TeamRun | null
  teamStatus?: React.ReactNode
  /** Git operation props for Changes tab */
  gitProps?: {
    branchName: string
    targetBranch: string
    commitMessage?: string | null
    canRunGitOperations: boolean
    onRefreshCommitMessage?: () => void | Promise<unknown>
    onConflict: (details?: import('./GitOperationsDialog').ConflictDetails) => void
    onResolveConflicts: () => void
  }
  /** Workspace switcher props (multi-workspace) */
  workspaces?: Workspace[]
  selectedWorkspaceId?: string | null
  onSelectWorkspace?: (workspaceId: string) => void
  /** Imperative ref to switch tabs from parent */
  tabRef?: React.RefObject<{ setTab: (tab: WorkspaceTab) => void } | null>
}

// ============================================================
// Tab 配置
// ============================================================

interface TabConfig {
  key: WorkspaceTabWithTeam
  label: string
  icon: React.ReactNode
}

const DESKTOP_TABS: TabConfig[] = [
  { key: "changes", label: "Changes", icon: <GitGraph size={14} /> },
  { key: "history", label: "History", icon: <History size={14} /> },
  { key: "editor", label: "Editor", icon: <Code2 size={14} /> },
  { key: "terminal", label: "Terminal", icon: <Terminal size={14} /> },
  { key: "preview", label: "Preview", icon: <Globe size={14} /> },
]

const MOBILE_TABS: TabConfig[] = [
  { key: "history", label: "History", icon: <History size={14} /> },
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

export const WorkspacePanel: React.FC<WorkspacePanelProps> = React.memo(
  function WorkspacePanel({
    className,
    sessionId: _sessionId,
    workspaceId,
    workingDir,
    projectId,
    hideChanges,
    readOnly,
    repoDeleted,
    teamRun,
    teamStatus,
    gitProps,
    workspaces,
    selectedWorkspaceId,
    onSelectWorkspace,
    tabRef,
  }) {
    const { t } = useI18n()
    const tabs = useMemo(() => {
      const baseTabs = hideChanges ? MOBILE_TABS : DESKTOP_TABS
      const availableTabs = readOnly
        ? baseTabs.filter((tab) => tab.key !== 'terminal')
        : baseTabs

      return teamRun
        ? [{ key: "team-status" as const, label: "Team Status", icon: <Users size={14} /> }, ...availableTabs]
        : availableTabs
    }, [hideChanges, readOnly, teamRun])
    const [activeTab, setActiveTab] = useState<WorkspaceTabWithTeam>(hideChanges ? "history" : "changes")

    useImperativeHandle(tabRef, () => ({
      setTab: (tab: WorkspaceTab) => setActiveTab(tab),
    }), [])

    // Fetch project to get quickCommands
    const { data: project } = useProject(projectId ?? '')
    const quickCommands = useMemo<QuickCommand[]>(() => {
      if (!project?.quickCommands) return []
      try { return JSON.parse(project.quickCommands) } catch { return [] }
    }, [project?.quickCommands])

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

    useEffect(() => {
      if (!readOnly) return
      if (activeTab === 'terminal') {
        setActiveTab(hideChanges ? 'history' : 'changes')
      }
    }, [activeTab, hideChanges, readOnly])

    useEffect(() => {
      if (teamRun || activeTab !== 'team-status') return
      setActiveTab(hideChanges ? 'history' : 'changes')
    }, [activeTab, hideChanges, teamRun])

    const showSwitcher = !!onSelectWorkspace && buildWorkspaceViews(workspaces, teamRun).length > 1

    return (
      <div className={cn("flex flex-col h-full bg-white", className)}>
        {readOnly && (
          <div className="mx-2 mt-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
            {repoDeleted
              ? t('项目已删除且本地仓库文件已清理。这里只保留历史视图。')
              : t('项目已删除。Workspace 以只读模式展示历史内容。')}
          </div>
        )}
        {/* Tab 栏 — folder style */}
        <div className="flex items-center px-2 pt-2 border-b border-neutral-200 bg-neutral-100/80 shrink-0 gap-1 select-none">
          {tabs.map((tab) => (
            <TabButton
              key={tab.key}
              active={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
              icon={tab.icon}
              label={t(tab.label)}
            />
          ))}
        </div>

        {/* Content area: flex column so switcher toolbar + tab body stack properly */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {showSwitcher && (
            <div className="shrink-0 px-3 py-1.5 border-b border-neutral-100 bg-neutral-50/60">
              <WorkspaceSwitcher
                workspaces={workspaces}
                teamRun={teamRun}
                selectedWorkspaceId={selectedWorkspaceId}
                onSelectWorkspace={onSelectWorkspace!}
                buttonClassName="h-7 text-[11px]"
              />
            </div>
          )}

          {/* Tab body — fills remaining space; absolute children stay within */}
          <div className="relative flex-1 min-h-0 overflow-hidden">
            {activeTab === "team-status" && teamRun && (
              teamStatus
            )}

            {activeTab === "editor" && (
              <EditorView workingDir={workingDir} readOnly={readOnly} />
            )}

            {terminalDirs.map(dir => {
              const visible = activeTab === "terminal" && workingDir === dir
              return (
                <div
                  key={dir}
                  className="h-full absolute inset-0"
                  style={{ display: visible ? 'block' : 'none' }}
                >
                  <TerminalTabs cwd={dir} isVisible={visible} quickCommands={quickCommands} />
                </div>
              )
            })}

            {activeTab === "preview" && (
              <PreviewPanel workspaceId={workspaceId} readOnly={readOnly} />
            )}

            {activeTab === "changes" && (
              <ChangesView
                workingDir={workingDir}
                workspaceId={workspaceId}
                branchName={gitProps?.branchName}
                targetBranch={gitProps?.targetBranch}
                commitMessage={gitProps?.commitMessage}
                canRunGitOperations={gitProps?.canRunGitOperations}
                onRefreshCommitMessage={gitProps?.onRefreshCommitMessage}
                onConflict={gitProps?.onConflict}
                onResolveConflicts={gitProps?.onResolveConflicts}
              />
            )}

            {activeTab === "history" && (
              <HistoryView workingDir={workingDir} />
            )}
          </div>
        </div>
      </div>
    )
  }
)
