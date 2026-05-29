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
  HIBERNATED = 'HIBERNATED',
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

/** 团队运行模式 */
export type TeamRunMode = 'CONFIRM' | 'AUTO'

/** TeamRun 进入评审的原因 */
export type TeamRunReviewReason =
  | 'READY'
  | 'TEAM_QUIESCENT'
  | 'PENDING_APPROVAL'
  | 'FAILED'
  | 'ENDED_WITHOUT_ROOM_REPLY'

/** 团队成员工作区策略 */
export type WorkspacePolicy = 'none' | 'shared' | 'dedicated'

/** 团队成员触发策略 */
export type TeamMemberTriggerPolicy = 'MENTION_ONLY' | 'USER_MESSAGES'

/** 团队成员 Session 策略 */
export type TeamMemberSessionPolicy = 'new_per_request' | 'resume_last'

/** 团队成员队列管理策略 */
export type TeamMemberQueueManagementPolicy = 'own_only' | 'team_pending'

/** 目标成员忙碌时的处理策略 */
export type IfBusyPolicy = 'queue' | 'cancel_current_and_start'

/** 团队成员状态 */
export type TeamMemberStatus =
  | 'IDLE'
  | 'PENDING_APPROVAL'
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING'
  | 'WAITING_ROOM_REPLY'
  | 'SESSION_ENDED'
  | 'READY_FOR_REVIEW'
  | 'FAILED'
  | 'CANCELLED'
  | (string & {})

/** 房间消息发送者类型 */
export type RoomMessageSenderType = 'user' | 'agent' | 'system'

/** 房间消息类型 */
export type RoomMessageKind =
  | 'chat'
  | 'work_request'
  | 'work_started'
  | 'artifact'
  | 'review'
  | 'decision'
  | 'system'

/** 工作请求发起者类型 */
export type WorkRequestRequesterType = 'user' | 'agent' | 'system'

/** 工作请求状态 */
export type WorkRequestStatus =
  | 'PENDING_APPROVAL'
  | 'QUEUED'
  | 'STARTED'
  | 'REJECTED'
  | 'CANCELLED'

/** Agent 调用状态 */
export type AgentInvocationStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SESSION_ENDED'
  | 'WAITING_ROOM_REPLY'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

/** 团队成员能力开关 */
export interface TeamMemberCapabilities {
  readRoom: boolean
  postRoomMessage: boolean
  mentionMembers: boolean
  stopMemberWork: boolean
  markReadyForReview: boolean
  readFiles: boolean
  writeFiles: boolean
  runCommands: boolean
  readDiff: boolean
  mergeWorkspace: boolean
}

/** 房间消息中的结构化提及 */
export interface StructuredMention {
  memberId: string
  label?: string
  ifBusy?: IfBusyPolicy
  cancelQueued?: boolean
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

export type ProviderBackupMode = 'full'

export interface ProviderBackupFile {
  version: 1
  kind: 'provider-backup'
  exportedAt: string
  mode: ProviderBackupMode
  providers: Provider[]
}

export interface ProviderImportSummary {
  create: number
  overwrite: number
  skip: number
}

export type ProviderImportAction = 'CREATE' | 'OVERWRITE' | 'SKIP'

export interface ProviderImportPreviewItem {
  action: ProviderImportAction
  incoming: Provider
  existing?: Provider | null
}

export interface ProviderImportPreview {
  summary: ProviderImportSummary
  items: ProviderImportPreviewItem[]
}

export interface ProviderImportResult {
  summary: ProviderImportSummary
  providers: Provider[]
}
// ============ 核心实体类型 ============

/** 终端快捷命令 */
export interface QuickCommand {
  name: string
  command: string
}

export type SlashCommandKind = 'builtin' | 'command' | 'skill'
export type SlashCommandScope = 'project' | 'user'

export interface SlashCommandOption {
  command: string
  description: string
  aliases?: string[]
  kind?: SlashCommandKind
  scope?: SlashCommandScope
}

export interface SlashCommandCatalogResponse {
  commands: SlashCommandOption[]
}

/** 项目 */
export interface Project {
  id: string
  name: string
  color: string
  description?: string
  /** 仓库路径 (对应 Prisma repoPath) */
  repoPath: string
  /** origin remote URL（如果可用） */
  repoRemoteUrl?: string | null
  /** 主分支名称，默认 "main" */
  mainBranch: string
  /** 逗号分隔的 glob/路径列表，worktree 创建后自动复制 */
  copyFiles?: string | null
  /** 多行命令文本，worktree 创建后自动执行 */
  setupScript?: string | null
  /** JSON 字符串: QuickCommand[]，终端快捷命令 */
  quickCommands?: string | null
  archivedAt?: string | null
  repoDeletedAt?: string | null
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
  /** 关联的 TeamRun（存在时表示团队模式） */
  teamRun?: TeamRun | null
  createdAt?: string
  updatedAt?: string
}

/** 工作空间 */
export interface Workspace {
  id: string
  taskId: string
  /** Parent workspace for TeamRun dedicated child workspaces. Null for root/main workspaces. */
  parentWorkspaceId?: string | null
  /** TeamRun member that owns this dedicated child workspace. Null for root/shared workspaces. */
  ownerMemberId?: string | null
  /** 分支名称 (对应 Prisma branchName) */
  branchName: string
  /** 创建 workspace 时记录的基准分支 */
  baseBranch?: string | null
  /** worktree 路径 (对应 Prisma worktreePath) */
  worktreePath: string
  status: WorkspaceStatus
  /** AI 生成的 commit message（合并时使用） */
  commitMessage?: string | null
  /** Preview 代理目标（仅允许 loopback 地址） */
  previewTarget?: string | null
  /** 自动休眠时间 */
  hibernatedAt?: string | null
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

/** 团队成员预设 */
export interface MemberPreset {
  id: string
  name: string
  aliases: string[]
  providerId: string
  rolePrompt: string
  capabilities: TeamMemberCapabilities
  workspacePolicy: WorkspacePolicy
  triggerPolicy: TeamMemberTriggerPolicy
  sessionPolicy: TeamMemberSessionPolicy
  queueManagementPolicy: TeamMemberQueueManagementPolicy
  avatar?: string | null
  createdAt?: string
  updatedAt?: string
}

/** 团队模板 */
export interface TeamTemplate {
  id: string
  name: string
  members?: TeamTemplateMember[]
  createdAt?: string
  updatedAt?: string
}

/** 团队模板成员 */
export interface TeamTemplateMember {
  id: string
  teamTemplateId: string
  memberPresetId: string
  position: number
  memberPreset?: MemberPreset
}

/** Task 关联的一次团队协作运行 */
export interface TeamRun {
  id: string
  taskId: string
  /** Root workspace used as TeamRun main workspace for shared/none members and child workspace parent. */
  mainWorkspaceId?: string | null
  mode: TeamRunMode
  reviewReason?: TeamRunReviewReason | null
  task?: Task
  members?: TeamMember[]
  messages?: RoomMessage[]
  workRequests?: WorkRequest[]
  invocations?: AgentInvocation[]
  createdAt?: string
  updatedAt?: string
}

/** TeamRun 内的团队成员实例 */
export interface TeamMember {
  id: string
  teamRunId: string
  presetId?: string | null
  name: string
  aliases: string[]
  providerId: string
  rolePrompt: string
  capabilities: TeamMemberCapabilities
  workspacePolicy: WorkspacePolicy
  triggerPolicy: TeamMemberTriggerPolicy
  sessionPolicy: TeamMemberSessionPolicy
  queueManagementPolicy: TeamMemberQueueManagementPolicy
  avatar?: string | null
  status: TeamMemberStatus
  createdAt?: string
  updatedAt?: string
}

/** TeamRun 房间消息 */
export interface RoomMessage {
  id: string
  teamRunId: string
  senderType: RoomMessageSenderType
  senderId?: string | null
  senderInvocationId?: string | null
  kind: RoomMessageKind
  content: string
  mentions: StructuredMention[]
  workRequestIds?: string[] | null
  artifactRefs?: string[] | null
  attachmentIds?: string[] | null
  createdAt?: string
}

/** 指向团队成员的一次工作请求 */
export interface WorkRequest {
  id: string
  teamRunId: string
  requesterMemberId?: string | null
  requesterType: WorkRequestRequesterType
  targetMemberId: string
  triggerMessageId: string
  instruction: string
  ifBusy: IfBusyPolicy
  cancelQueued: boolean
  status: WorkRequestStatus
  createdAt?: string
  updatedAt?: string
}

/** 工作请求触发的一次 Agent 调用 */
export interface AgentInvocation {
  id: string
  teamRunId: string
  workRequestId: string
  memberId: string
  workspaceId?: string | null
  sessionId?: string | null
  status: AgentInvocationStatus
  roomReplyReminderCount: number
  nextRoomReplyReminderAt?: string | null
  createdAt?: string
  updatedAt?: string
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

/** 应用支持的语言 */
export type AppLocale = 'zh-CN' | 'en'

/** 全局应用设置 */
export interface AppSettings {
  id: string
  locale: AppLocale | null
  commitMessageProviderId: string | null
  commitMessagePrompt: string | null
}

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
