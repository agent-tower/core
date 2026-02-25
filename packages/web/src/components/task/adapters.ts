/**
 * 后端类型 → UI 类型 适配层
 *
 * 将 @agent-tower/shared 中的后端实体类型映射为前端组件所需的 UI 类型。
 * 所有类型转换逻辑集中在此文件，组件不直接操作后端类型。
 */
import type {
  Task as SharedTask,
  Project as SharedProject,
  Workspace as SharedWorkspace,
} from '@agent-tower/shared'
import { TaskStatus as SharedTaskStatus, AgentType } from '@agent-tower/shared'
import type { UITask, UIProject, UITaskDetailData } from './types'
import { UITaskStatus } from './types'

// ============ 状态映射 ============

/**
 * 将后端 TaskStatus 映射为 UI 展示状态
 *
 * | 后端 (SharedTaskStatus) | 前端 (UITaskStatus) |
 * |------------------------|---------------------|
 * | TODO                   | Pending             |
 * | IN_PROGRESS            | Running             |
 * | IN_REVIEW              | Review              |
 * | DONE                   | Done                |
 * | CANCELLED              | Cancelled           |
 */
export function mapTaskStatusToUI(status: SharedTaskStatus): UITaskStatus {
  switch (status) {
    case SharedTaskStatus.TODO:
      return UITaskStatus.Pending
    case SharedTaskStatus.IN_PROGRESS:
      return UITaskStatus.Running
    case SharedTaskStatus.IN_REVIEW:
      return UITaskStatus.Review
    case SharedTaskStatus.DONE:
      return UITaskStatus.Done
    case SharedTaskStatus.CANCELLED:
      return UITaskStatus.Cancelled
  }
}

/** 将 UI 展示状态映射回后端 TaskStatus（用于拖拽变更状态） */
export function mapUIStatusToTask(status: UITaskStatus): SharedTaskStatus {
  switch (status) {
    case UITaskStatus.Pending:
      return SharedTaskStatus.TODO
    case UITaskStatus.Running:
      return SharedTaskStatus.IN_PROGRESS
    case UITaskStatus.Review:
      return SharedTaskStatus.IN_REVIEW
    case UITaskStatus.Done:
      return SharedTaskStatus.DONE
    case UITaskStatus.Cancelled:
      return SharedTaskStatus.CANCELLED
  }
}

/**
 * 将 AgentType 枚举映射为用户友好的显示名称
 */
export function formatAgentType(agentType: AgentType): string {
  switch (agentType) {
    case AgentType.CLAUDE_CODE:
      return 'Claude Code'
    case AgentType.GEMINI_CLI:
      return 'Gemini CLI'
    case AgentType.CURSOR_AGENT:
      return 'Cursor Agent'
  }
}

// ============ 实体适配 ============

/** 预定义的项目颜色，用于后端未返回 color 时根据名称 hash 分配 */
const PROJECT_COLORS = [
  'text-indigo-600',
  'text-emerald-600',
  'text-rose-600',
  'text-amber-600',
  'text-cyan-600',
  'text-violet-600',
  'text-teal-600',
  'text-pink-600',
]

function hashStringToIndex(str: string, max: number): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % max
}

/**
 * 将后端 Project 转为 UI 层 Project
 *
 * 丢弃前端不需要的字段（repoPath, mainBranch 等），
 * 保留渲染所需的 id / name / color。
 * 后端无 color 字段时，根据项目名 hash 分配颜色。
 */
export function adaptProject(project: SharedProject): UIProject {
  return {
    id: project.id,
    name: project.name,
    color: project.color || PROJECT_COLORS[hashStringToIndex(project.name, PROJECT_COLORS.length)],
  }
}

/**
 * 从任务的工作空间列表中提取活跃 workspace 信息
 * 返回 agent 名称和分支名
 */
function extractActiveWorkspaceInfo(workspaces?: SharedWorkspace[]): {
  agent: string
  branch: string
} {
  if (!workspaces || workspaces.length === 0) {
    return { agent: '—', branch: '—' }
  }

  // 优先取 ACTIVE 状态的 workspace
  const active = workspaces.find(w => w.status === 'ACTIVE') ?? workspaces[0]
  const branch = active.branchName

  // 从活跃 workspace 的最新 session 获取 agent 类型
  const sessions = active.sessions
  if (sessions && sessions.length > 0) {
    const latestSession = sessions[sessions.length - 1]
    const agent = formatAgentType(latestSession.agentType as AgentType)
    return { agent, branch }
  }

  return { agent: '—', branch }
}

/**
 * 将后端 Task (+ 关联数据) 转为列表组件所需的 UITask
 *
 * @param task    - 后端 Task 实体（可带 workspaces 关联）
 * @returns UITask 对象，可直接传给 TaskGroup / TaskList
 */
export function adaptTaskForList(task: SharedTask): UITask {
  const { agent, branch } = extractActiveWorkspaceInfo(task.workspaces)

  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: mapTaskStatusToUI(task.status),
    agent,
    branch,
    description: task.description ?? '',
  }
}

/**
 * 将后端 Task + Project 转为详情组件所需的 UITaskDetailData
 *
 * @param task      - 后端 Task 实体
 * @param project   - 后端 Project 实体
 * @param workspace - 可选的活跃 Workspace（用于获取分支名）
 * @returns UITaskDetailData 对象，可直接传给 TaskDetail
 */
export function adaptTaskForDetail(
  task: SharedTask,
  project: SharedProject,
  workspace?: SharedWorkspace,
): UITaskDetailData {
  const branch = workspace?.branchName
    ?? task.workspaces?.[0]?.branchName
    ?? '—'

  return {
    id: task.id,
    projectName: project.name,
    projectColor: project.color || PROJECT_COLORS[hashStringToIndex(project.name, PROJECT_COLORS.length)],
    title: task.title,
    status: mapTaskStatusToUI(task.status),
    branch,
    mainBranch: project.mainBranch ?? 'main',
    description: task.description ?? '',
  }
}
