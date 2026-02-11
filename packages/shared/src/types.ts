/**
 * 核心业务类型定义
 * 前后端共享的实体类型、枚举与常量
 */

// ============ 枚举 / 常量 ============

/** 任务状态 */
export enum TaskStatus {
  TODO = 'TODO',
  IN_PROGRESS = 'IN_PROGRESS',
  IN_REVIEW = 'IN_REVIEW',
  DONE = 'DONE',
}

/** 工作空间状态 */
export enum WorkspaceStatus {
  ACTIVE = 'ACTIVE',
  MERGED = 'MERGED',
  ABANDONED = 'ABANDONED',
}

/** AI 代理类型 */
export enum AgentType {
  CLAUDE_CODE = 'CLAUDE_CODE',
  GEMINI_CLI = 'GEMINI_CLI',
  CURSOR_AGENT = 'CURSOR_AGENT',
}

/** 会话状态 */
export enum SessionStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

// ============ 核心实体类型 ============

/** 项目 */
export interface Project {
  id: string
  name: string
  color: string
  description?: string
  /** 仓库路径 (对应 Prisma repoPath) */
  repoPath: string
  /** 主分支名称，默认 "main" */
  mainBranch: string
  createdAt?: string
  updatedAt?: string
}

/** 任务 */
export interface Task {
  id: string
  projectId: string
  title: string
  description?: string
  status: TaskStatus
  /** 优先级 (对应 Prisma priority) */
  priority?: number
  /** 排序位置 (对应 Prisma position) */
  position?: number
  /** 关联的工作空间列表（API include 时返回） */
  workspaces?: Workspace[]
  createdAt?: string
  updatedAt?: string
}

/** 工作空间 */
export interface Workspace {
  id: string
  taskId: string
  /** 分支名称 (对应 Prisma branchName) */
  branchName: string
  /** worktree 路径 (对应 Prisma worktreePath) */
  worktreePath: string
  status: WorkspaceStatus
  /** 关联的会话列表（API include 时返回） */
  sessions?: Session[]
  createdAt?: string
  updatedAt?: string
}

/** 会话 */
export interface Session {
  id: string
  workspaceId: string
  agentType: AgentType
  status: SessionStatus
  startedAt?: string
  endedAt?: string
}

// ============ Agent Todo 类型 ============

/** Agent 生成的 Todo 项 */
export interface TodoItem {
  content: string
  status: string
  priority?: string | null
}

// ============ 辅助类型 ============

/** 代理可用性检查结果 */
export interface AgentAvailability {
  available: boolean
  version?: string
  error?: string
}

/** 执行器配置 */
export interface ExecutorConfig {
  workingDir: string
  prompt: string
  env?: Record<string, string>
}
