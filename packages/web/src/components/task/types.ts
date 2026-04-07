/**
 * UI 层类型定义
 *
 * 这些类型专用于前端组件渲染，与 @agent-tower/shared 中的后端实体类型分离。
 * 通过 adapters.ts 中的映射函数将后端类型转换为 UI 类型。
 */

// ============ UI 状态枚举 ============

/**
 * UI 展示用的任务状态
 *
 * 与后端 TaskStatus (TODO/IN_PROGRESS/IN_REVIEW/DONE) 不同，
 * 这是面向用户的友好显示值。
 * 映射关系见 adapters.ts 的 mapTaskStatusToUI。
 */
export const UITaskStatus = {
  Review: 'Review',
  Running: 'Running',
  Pending: 'Pending',
  Done: 'Done',
  Cancelled: 'Cancelled',
} as const

export type UITaskStatus = (typeof UITaskStatus)[keyof typeof UITaskStatus]

// ============ UI 实体类型 ============

/** UI 层项目类型 — 仅包含渲染所需字段 */
export interface UIProject {
  id: string
  name: string
  /** Tailwind text color class, e.g., 'text-blue-600' */
  color: string
  archivedAt?: string | null
  repoDeletedAt?: string | null
}

/**
 * UI 层任务类型 — 用于列表渲染
 *
 * 相比后端 Task，额外携带了 agent / branch 等来自 Workspace/Session 的展示信息。
 */
export interface UITask {
  id: string
  projectId: string
  title: string
  status: UITaskStatus
  /** 执行该任务的 Agent 名称（来自活跃 Session） */
  agent: string
  /** 当前工作分支（来自活跃 Workspace） */
  branch: string
  description: string
  projectArchivedAt?: string | null
  projectRepoDeletedAt?: string | null
}

/**
 * UI 层任务详情类型 — 用于 TaskDetail 组件
 *
 * 包含项目信息、日志等完整渲染数据。
 */
export interface UITaskDetailData {
  id: string
  projectId: string
  projectName: string
  projectColor: string
  title: string
  status: UITaskStatus
  /** 当前工作分支（来自活跃 Workspace） */
  branch: string
  /** Git 操作目标基础分支（优先 workspace.baseBranch） */
  mainBranch: string
  description: string
  projectArchivedAt?: string | null
  projectRepoDeletedAt?: string | null
}
