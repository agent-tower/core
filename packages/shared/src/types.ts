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
  CANCELLED = 'CANCELLED',
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
  CODEX = 'CODEX',
}

/** 会话状态 */
export enum SessionStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

/** 会话用途 */
export enum SessionPurpose {
  /** 正常用户交互会话 */
  CHAT = 'CHAT',
  /** 内部：生成 commit message */
  COMMIT_MSG = 'COMMIT_MSG',
}


// ============ Provider ============

/** Provider 配置 */
export interface Provider {
  id: string;
  name: string;
  agentType: AgentType | string;
  env: Record<string, string>;
  config: Record<string, unknown>;
  /** CLI 原生配置字符串（Claude Code: JSON, Codex: TOML） */
  settings?: string;
  isDefault: boolean;
  builtIn?: boolean;
  createdAt?: string;
}
// ============ 核心实体类型 ============

/** 终端快捷命令 */
export interface QuickCommand {
  name: string
  command: string
}

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
  /** 逗号分隔的 glob/路径列表，worktree 创建后自动复制 */
  copyFiles?: string | null
  /** 多行命令文本，worktree 创建后自动执行 */
  setupScript?: string | null
  /** JSON 字符串: QuickCommand[]，终端快捷命令 */
  quickCommands?: string | null
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
  /** AI 生成的 commit message（合并时使用） */
  commitMessage?: string | null
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
  /** 会话用途 */
  purpose?: SessionPurpose
  /** 使用的 Provider ID */
  providerId?: string | null
  tokenUsage?: { totalTokens: number; modelContextWindow?: number } | null
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

// ============ Git 操作类型 ============

/** 冲突操作类型 */
export enum ConflictOp {
  REBASE = 'REBASE',
  MERGE = 'MERGE',
}

/** Git 操作状态 */
export interface GitOperationStatus {
  /** 当前操作类型 */
  operation: 'idle' | 'rebase' | 'merge'
  /** 冲突文件列表 */
  conflictedFiles: string[]
  /** 冲突操作类型（仅在有冲突时有值） */
  conflictOp: ConflictOp | null
  /** 领先基础分支的提交数 */
  ahead: number
  /** 落后基础分支的提交数 */
  behind: number
  /** 是否有未提交的变更（tracked 文件） */
  hasUncommittedChanges: boolean
  /** 未提交变更的文件数 */
  uncommittedCount: number
  /** 未跟踪文件数 */
  untrackedCount: number
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

// ============ 附件类型 ============

/** 附件 */
export interface Attachment {
  id: string
  originalName: string
  mimeType: string
  sizeBytes: number
  /** HTTP 访问路径: /attachments/:id/file */
  url: string
  /** 磁盘绝对路径，用于传给 agent */
  storagePath: string
  createdAt?: string
}

// ============ 通知类型 ============

/** 第三方通知渠道 */
export type ThirdPartyChannel = 'none' | 'feishu'

/** 通知事件类型 */
export type NotificationEventType = 'task_in_review' | 'task_failed'

/** 通知配置 */
export interface NotificationSettings {
  id: string
  osNotificationEnabled: boolean
  thirdPartyChannel: ThirdPartyChannel
  feishuWebhookUrl: string | null
  thirdPartyBaseUrl: string | null
  taskInReviewTitleTemplate: string
  taskInReviewBodyTemplate: string
}
