import React, { useState, useRef, useEffect, useMemo, useImperativeHandle, useCallback } from "react"
import { Code2, Terminal, Globe, GitGraph, History, PanelRightClose, Users } from "lucide-react"
import type { TeamRun, Workspace } from "@agent-tower/shared"

import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n"
import { TerminalTabs } from "./TerminalTabs"
import { EditorView, type EditorViewHandle } from "./EditorView"
import { ReviewView } from "./ReviewView"
import { HistoryView } from "./HistoryView"
import { PreviewPanel, type PreviewOpenRequest } from "./PreviewPanel"
import { WorkspaceSwitcher } from "./WorkspaceSwitcher"
import { buildWorkspaceViews } from "./team-workspace-view"
import { useProject } from "@/hooks/use-projects"
import { useGitVisibilityStore, type VisibleGitTab } from "@/stores/git-visibility-store"
import type { QuickCommand } from "@agent-tower/shared"

export type WorkspaceTab = "editor" | "terminal" | "preview" | "review" | "history"
type WorkspaceTabWithTeam = WorkspaceTab | "team-status"

export interface WorkspacePanelHandle {
  setTab: (tab: WorkspaceTab) => void
  openFile: (path: string, line?: number, column?: number) => void
  openPreview: (url: string, workspaceId?: string) => void
}

export type WorkspacePreviewRequest = PreviewOpenRequest

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
  gitAvailable?: boolean
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
  /** Desktop side panel style: persistent icon rail + expandable content */
  variant?: 'tabs' | 'rail'
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  minContentWidth?: number
  /** Imperative ref to switch tabs from parent */
  tabRef?: React.RefObject<WorkspacePanelHandle | null>
  previewRequest?: WorkspacePreviewRequest
  onPreviewRequestHandled?: (requestId: number) => void
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
  { key: "review", label: "Changes", icon: <GitGraph size={14} /> },
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
    type="button"
    onClick={onClick}
    className={cn(
      "flex shrink-0 items-center gap-2 px-4 py-2 text-xs font-medium transition-all rounded-t-md border-t border-x -mb-px whitespace-nowrap",
      active
        ? "bg-white border-neutral-200 text-neutral-900 shadow-[0_-2px_6px_rgba(0,0,0,0.02)] z-10"
        : "bg-transparent border-transparent text-neutral-500 hover:text-neutral-700 hover:bg-neutral-200/50"
    )}
  >
    {icon}
    <span>{label}</span>
  </button>
)

const RailTabButton: React.FC<{
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}> = ({ active, onClick, icon, label }) => (
  <button
    type="button"
    onClick={onClick}
    title={label}
    aria-label={label}
    aria-pressed={active}
    className={cn(
      "flex h-9 w-9 items-center justify-center rounded-lg border text-muted-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
      active
        ? "border-neutral-900 bg-neutral-900 text-white shadow-sm"
        : "border-transparent hover:border-border hover:bg-background hover:text-foreground"
    )}
  >
    {icon}
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
    gitAvailable = true,
    readOnly,
    repoDeleted,
    teamRun,
    teamStatus,
    gitProps,
    workspaces,
    selectedWorkspaceId,
    onSelectWorkspace,
    variant = 'tabs',
    expanded,
    onExpandedChange,
    minContentWidth = 520,
    tabRef,
    previewRequest,
    onPreviewRequestHandled,
  }) {
    const { t } = useI18n()
    const setVisibleGitContext = useGitVisibilityStore((state) => state.setVisibleContext)
    const isRailVariant = variant === 'rail'
    const [internalExpanded, setInternalExpanded] = useState(false)
    const isExpanded = isRailVariant ? expanded ?? internalExpanded : true

    const setPanelExpanded = useCallback((nextExpanded: boolean) => {
      if (expanded === undefined) {
        setInternalExpanded(nextExpanded)
      }
      onExpandedChange?.(nextExpanded)
    }, [expanded, onExpandedChange])

    const tabs = useMemo(() => {
      const baseTabs = hideChanges ? MOBILE_TABS : DESKTOP_TABS
      const gitFilteredTabs = gitAvailable
        ? baseTabs
        : baseTabs.filter((tab) => tab.key !== 'review' && tab.key !== 'history')
      const availableTabs = readOnly
        ? gitFilteredTabs.filter((tab) => tab.key !== 'terminal')
        : gitFilteredTabs

      return teamRun
        ? [{ key: "team-status" as const, label: "Team Status", icon: <Users size={14} /> }, ...availableTabs]
        : availableTabs
    }, [gitAvailable, hideChanges, readOnly, teamRun])
    const [activeTab, setActiveTab] = useState<WorkspaceTabWithTeam>(() => (
      previewRequest
        ? 'preview'
        : gitAvailable
          ? (hideChanges ? "history" : "review")
          : "editor"
    ))
    const editorRef = useRef<EditorViewHandle | null>(null)
    const previewRequestIdRef = useRef(0)
    const [imperativePreviewRequest, setImperativePreviewRequest] = useState<PreviewOpenRequest | undefined>()

    const selectTab = useCallback((tab: WorkspaceTabWithTeam) => {
      setActiveTab(tab)
      if (isRailVariant) {
        setPanelExpanded(true)
      }
    }, [isRailVariant, setPanelExpanded])

    useImperativeHandle(tabRef, () => ({
      setTab: (tab: WorkspaceTab) => selectTab(tab),
      openFile: (path: string, line?: number, column?: number) => {
        selectTab('editor')
        requestAnimationFrame(() => editorRef.current?.openFile(path, line, column))
      },
      openPreview: (url: string, requestWorkspaceId?: string) => {
        previewRequestIdRef.current += 1
        setImperativePreviewRequest({
          id: previewRequestIdRef.current,
          url,
          workspaceId: requestWorkspaceId,
        })
        selectTab('preview')
      },
    }), [selectTab])

    const activePreviewRequest = previewRequest ?? imperativePreviewRequest
    const scopedPreviewRequest = activePreviewRequest?.workspaceId
      && activePreviewRequest.workspaceId !== workspaceId
      ? undefined
      : activePreviewRequest
    const handlePreviewRequestHandled = useCallback((requestId: number) => {
      setImperativePreviewRequest((current) => current?.id === requestId ? undefined : current)
      onPreviewRequestHandled?.(requestId)
    }, [onPreviewRequestHandled])

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
      if (tabs.some((tab) => tab.key === activeTab)) return
      setActiveTab(tabs[0]?.key ?? 'editor')
    }, [activeTab, tabs])

    useEffect(() => {
      if (isRailVariant && !isExpanded) {
        return
      }

      const gitTab: VisibleGitTab | null = activeTab === 'review'
        ? 'changes'
        : activeTab === 'history'
          ? 'history'
          : null

      if (!workspaceId || !workingDir || !gitTab) {
        setVisibleGitContext(null)
        return
      }

      setVisibleGitContext({ workspaceId, workingDir, tab: gitTab })
      return () => {
        setVisibleGitContext(null)
      }
    }, [activeTab, isExpanded, isRailVariant, setVisibleGitContext, workingDir, workspaceId])

    const showSwitcher = !!onSelectWorkspace && buildWorkspaceViews(workspaces, teamRun).length > 1
    const activeTabConfig = tabs.find((tab) => tab.key === activeTab) ?? tabs[0]
    const translatedActiveLabel = activeTabConfig ? t(activeTabConfig.label) : ''

    const readOnlyNotice = readOnly ? (
      <div className="mx-2 mt-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
        {repoDeleted
          ? t('项目已删除且本地仓库文件已清理。这里只保留历史视图。')
          : t('项目已删除。Workspace 以只读模式展示历史内容。')}
      </div>
    ) : null

    const content = (
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
            <EditorView ref={editorRef} workingDir={workingDir} readOnly={readOnly} />
          )}

          {terminalDirs.map(dir => {
            const visible = activeTab === "terminal" && workingDir === dir
            return (
              <div
                key={dir}
                aria-hidden={!visible}
                className="absolute inset-0 h-full w-full min-h-0 min-w-0 overflow-hidden"
                style={{ display: visible ? 'block' : 'none' }}
              >
                <TerminalTabs cwd={dir} isVisible={visible} quickCommands={quickCommands} />
              </div>
            )
          })}

          {activeTab === "preview" && (
            <PreviewPanel
              workspaceId={workspaceId}
              readOnly={readOnly}
              navigationRequest={scopedPreviewRequest}
              onNavigationRequestHandled={handlePreviewRequestHandled}
            />
          )}

          {activeTab === "review" && (
            <ReviewView
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
    )

    if (isRailVariant) {
      return (
        <div className={cn("flex h-full w-full min-w-0 bg-white", className)}>
          <div className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-l border-border bg-muted/35 px-1.5 py-2">
            {tabs.map((tab) => (
              <RailTabButton
                key={tab.key}
                active={isExpanded && activeTab === tab.key}
                onClick={() => selectTab(tab.key)}
                icon={tab.icon}
                label={t(tab.label)}
              />
            ))}
          </div>

          {isExpanded && (
            <div
              className="flex h-full min-w-0 flex-1 flex-col border-l border-border bg-background"
              style={{ minWidth: minContentWidth }}
            >
              {readOnlyNotice}
              <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3">
                <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/35 text-muted-foreground">
                    {activeTabConfig?.icon}
                  </span>
                  <span className="truncate">{translatedActiveLabel}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setPanelExpanded(false)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  title={t('收起')}
                  aria-label={t('收起')}
                >
                  <PanelRightClose size={15} />
                </button>
              </div>
              {content}
            </div>
          )}
        </div>
      )
    }

    return (
      <div className={cn("flex h-full w-full min-w-0 flex-col bg-white", className)}>
        {readOnly && (
          readOnlyNotice
        )}
        {/* Tab 栏 — folder style */}
        <div className="flex items-center overflow-x-auto scrollbar-app-thin px-2 pt-2 border-b border-neutral-200 bg-neutral-100/80 shrink-0 gap-1 select-none">
          {tabs.map((tab) => (
            <TabButton
              key={tab.key}
              active={activeTab === tab.key}
              onClick={() => selectTab(tab.key)}
              icon={tab.icon}
              label={t(tab.label)}
            />
          ))}
        </div>

        {content}
      </div>
    )
  }
)
