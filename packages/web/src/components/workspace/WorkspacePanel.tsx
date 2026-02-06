import React from "react"
import { GitGraph } from "lucide-react"

import { cn } from "@/lib/utils"

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

export interface WorkspacePanelProps {
  /** 文件变更列表 */
  changes?: FileChange[]
  /** 当前分支名 */
  branch?: string
  /** 自定义类名 */
  className?: string
}

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

interface FileItemProps {
  name: string
  status: FileChangeStatus
}

const FileItem: React.FC<FileItemProps> = ({ name, status }) => {
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

// ============================================================
// 主组件 — 使用 React.memo 避免父组件状态变化导致不必要重渲染
// ============================================================

export const WorkspacePanel: React.FC<WorkspacePanelProps> = React.memo(
  function WorkspacePanel({
    changes = MOCK_CHANGES,
    branch = MOCK_BRANCH,
    className,
  }) {
    const changedCount = changes.filter(
      (c) => c.status === "M" || c.status === "A" || c.status === "R"
    ).length
    const untrackedCount = changes.filter((c) => c.status === "U").length
    const deletedCount = changes.filter((c) => c.status === "D").length

    return (
      <div
        className={cn("flex flex-col h-full bg-white", className)}
      >
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
)
