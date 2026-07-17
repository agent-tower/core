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

/** 工作空间存储模式 */
export enum WorkspaceKind {
  WORKTREE = 'WORKTREE',
  MAIN_DIRECTORY = 'MAIN_DIRECTORY',
}

export type WorkspaceStorageMode = WorkspaceKind

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

/** 会话执行上下文 */
export enum SessionContext {
  /** 项目任务工作区 */
  WORKSPACE = 'WORKSPACE',
  /** 独立对话目录 */
  CONVERSATION = 'CONVERSATION',
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

/** TeamRun 成员生命周期状态 */
export type TeamMemberMembershipStatus = 'ACTIVE' | 'REMOVED'

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
  | 'REMOVED'
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

/** 房间消息可见性 */
export type RoomMessageVisibility = 'PUBLIC' | 'PRIVATE'

/** RoomMessage.content 当前承载的是完整正文还是预览 */
export type RoomMessageContentMode = 'preview' | 'full'

/** 私聊消息参与者角色 */
export type RoomMessageParticipantRole = 'sender' | 'recipient'

/** 工作请求发起者类型 */
export type WorkRequestRequesterType = 'user' | 'agent' | 'system'

/** 工作请求状态 */
export type WorkRequestStatus =
  | 'PENDING_APPROVAL'
  | 'QUEUED'
  | 'STARTED'
  | 'REJECTED'
  | 'COMPLETED'
  | 'FAILED'
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

/** 工作区审查/测试记录类型 */
export type WorkspaceVerdictKind = 'REVIEW' | 'TEST'

/** 工作区审查/测试结论 */
export type WorkspaceVerdictValue =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'PASSED'
  | 'FAILED'

/** WorkRequest 绑定的目标类型 */
export type WorkRequestTargetKind = 'WORKSPACE_COMMIT'

/** WorkRequest 绑定目标的使用目的 */
export type WorkRequestTargetPurpose = 'REVIEW' | 'TEST'

/** AgentInvocation target workspace 同步状态 */
export type AgentInvocationTargetSyncStatus = 'PENDING' | 'SYNCED' | 'FAILED'

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

/** 指向一个 TeamRun workspace commit 的派活目标 */
export interface WorkspaceCommitTarget {
  kind: WorkRequestTargetKind
  purpose: WorkRequestTargetPurpose
  sourceWorkspaceId: string
  headSha: string
  branchName: string
  planItemId?: string | null
}

/** 房间消息中的结构化提及 */
export interface StructuredMention {
  memberId: string
  label?: string
  ifBusy?: IfBusyPolicy
  cancelQueued?: boolean
  target?: WorkspaceCommitTarget | null
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
  /** 当前项目路径是否包含 Git 元数据。非 Git 项目首版仅支持本地 Solo。 */
  isGitRepo?: boolean
  /** 当前 Git 仓库是否已经具备创建 worktree 所需的 HEAD commit。 */
  worktreeReady?: boolean
  /** Git/worktree 能力检测原因。 */
  reason?: ProjectGitCapabilityReason
  /** Last time Git capability was verified with the Git CLI. */
  gitCapabilityCheckedAt?: string | null
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

export type ProjectGitCapabilityReason =
  | 'NO_GIT'
  | 'NO_HEAD'
  | 'READY'
  | 'INVALID_REPOSITORY'

export interface ProjectGitCapability {
  isGitRepo: boolean
  worktreeReady: boolean
  reason: ProjectGitCapabilityReason
}

/** 任务 */
export interface Task {
  id: string
  projectId: string
  title: string
  /** Short, display-safe title for list/header hot paths. */
  titlePreview?: string
  description?: string
  /** Short preview of long task body/content when the full field is omitted. */
  contentPreview?: string
  /** True when one or more large text fields were truncated in this payload. */
  isTruncated?: boolean
  status: TaskStatus
  /** 优先级 (对应 Prisma priority) */
  priority?: number
  /** 排序位置 (对应 Prisma position) */
  position?: number
  /** 关联的工作空间列表（API include 时返回） */
  workspaces?: Workspace[]
  /** 关联的 TeamRun（存在时表示团队模式） */
  teamRun?: TeamRun | null
  /** 任务所属项目（API include 时返回） */
  project?: Project
  createdAt?: string
  updatedAt?: string
}

export type TaskBodySource = 'description' | 'historical_title' | 'none'

/** Full task body loaded only on explicit demand. */
export interface TaskBody {
  taskId: string
  title: string
  titlePreview: string
  body: string
  bodySource: TaskBodySource
  prompt: string
  isTruncated: boolean
}

/** Workspace fields required by the task board list. */
export interface TaskBoardWorkspaceSummary {
  /** Omitted for the default WORKTREE kind. */
  workspaceKind?: WorkspaceKind
  branchName: string
}

/** Compact task read model used by the board list hot path. */
export interface TaskBoardItem {
  id: string
  projectId: string
  title: string
  status: TaskStatus
  preferredWorkspace?: TaskBoardWorkspaceSummary
  latestAgentType?: AgentType
  hasRunningSession?: true
  updatedAt: number
}

export interface TaskBoardResponse {
  data: TaskBoardItem[]
  total: number
  page: number
  limit: number
  totalPages: number
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
  /** Workspace 存储模式 */
  workspaceKind: WorkspaceKind
  /** Agent/Editor/Terminal 使用的实际工作目录 */
  workingDir: string
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

export type PreviewSessionMode = 'local' | 'remote'

export interface PreviewStatus {
  configured: boolean
  ready: boolean
  target: string | null
  /** Legacy same-origin URL retained for old clients during the gateway migration. */
  viewUrl: string | null
  error: string | null
}

export interface PreviewSession {
  id: string
  target: string
  mode: PreviewSessionMode
  viewUrl: string
  expiresAt: string
}

export interface OpenPreviewSessionInput {
  mode: PreviewSessionMode
  localHostname: string
}

/** 工作区审查/测试记录 */
export interface WorkspaceVerdict {
  id: string
  workspaceId: string
  teamRunId: string
  kind: WorkspaceVerdictKind
  verdict: WorkspaceVerdictValue
  reviewedSha: string
  reviewerMemberId?: string | null
  reason?: string | null
  sequence: number
  createdAt?: string
}

export type MergeReadinessBlockerSeverity = 'BLOCKING' | 'WARNING'

export type MergeReadinessBlockerCode =
  | 'WORKSPACE_NOT_ACTIVE'
  | 'WORKSPACE_ALREADY_MERGED'
  | 'WORKSPACE_ABANDONED'
  | 'WORKSPACE_HIBERNATED'
  | 'INVALID_WORKSPACE_STATE'
  | 'INVALID_PARENT_WORKSPACE'
  | 'INVALID_PARENT_WORKSPACE_STATE'
  | 'WORKSPACE_GIT_UNAVAILABLE'
  | 'MISSING_HEAD_SHA'
  | 'REVIEW_REQUIRED'
  | 'REVIEW_STALE'
  | 'SELF_REVIEW_FORBIDDEN'
  | 'OWNER_HAS_ACTIVE_INVOCATION'
  | 'PARENT_WORKSPACE_HAS_ACTIVE_SESSION'
  | 'WORKTREE_DIRTY'
  | 'REBASE_IN_PROGRESS'
  | 'MERGE_CONFLICT'
  | 'BRANCHES_DIVERGED'
  | 'BEHIND_MAIN'
  | 'GIT_STATUS_UNAVAILABLE'
  | 'PROJECT_MERGE_LOCKED'
  | 'TEAM_RUN_MERGE_INVOCATION_REQUIRED'
  | 'TEAM_RUN_MEMBER_CAPABILITY_REQUIRED'
  | 'FORBIDDEN'
  | 'UNKNOWN'
  | (string & {})

export interface MergeReadinessBlocker {
  code: MergeReadinessBlockerCode
  severity: MergeReadinessBlockerSeverity
  message: string
  details?: Record<string, unknown>
}

export interface MergeableWorkspaceMainWorkspace {
  id: string | null
  branchName: string | null
  status: WorkspaceStatus | string | null
  headSha?: string | null
  hasActiveWriteSession: boolean
}

export interface MergeableWorkspaceOwner {
  memberId: string
  name: string
  membershipStatus?: TeamMemberMembershipStatus | string
}

export interface MergeableWorkspaceGitInfo {
  clean: boolean | null
  aheadOfMain: number | null
  behindMain: number | null
  operation: GitOperationStatus['operation'] | null
  conflictedFiles: string[]
  hasUncommittedChanges: boolean | null
  uncommittedCount: number | null
  untrackedCount: number | null
  statusAvailable: boolean
}

export interface MergeableWorkspaceActivityInfo {
  ownerHasActiveInvocation: boolean
  parentHasActiveWriteSession: boolean
}

export interface MergeableWorkspaceVerdictSnapshot {
  id: string
  verdict: WorkspaceVerdictValue
  reviewedSha: string
  reviewerMemberId?: string | null
  reason?: string | null
  sequence: number
  createdAt?: string
  matchesHead: boolean
  isSelfReview: boolean
}

export interface MergeableWorkspaceItem {
  workspaceId: string
  owner: MergeableWorkspaceOwner
  status: WorkspaceStatus | string
  branchName: string
  baseBranch?: string | null
  parentWorkspaceId: string
  headSha: string | null
  git: MergeableWorkspaceGitInfo
  activity: MergeableWorkspaceActivityInfo
  latestReview?: MergeableWorkspaceVerdictSnapshot | null
  latestTest?: MergeableWorkspaceVerdictSnapshot | null
  mergeReady: boolean
  blockers: MergeReadinessBlocker[]
}

export interface MergeableWorkspacesResponse {
  teamRunId: string
  taskId: string
  projectId: string
  mainWorkspace: MergeableWorkspaceMainWorkspace
  generatedAt: string
  workspaces: MergeableWorkspaceItem[]
}

export interface MergeTeamRunMembersInput {
  workspaceIds?: string[]
  dryRun?: boolean
  stopOnConflict?: boolean
}

export type MergeTeamRunMemberResultStatus =
  | 'MERGED'
  | 'ALREADY_MERGED'
  | 'WOULD_MERGE'
  | 'SKIPPED'
  | 'CONFLICT'
  | 'FAILED'

export interface MergeTeamRunMemberResult {
  workspaceId: string
  ownerMemberId?: string | null
  status: MergeTeamRunMemberResultStatus
  code?: string
  message?: string
  sha?: string
  blockers?: MergeReadinessBlocker[]
  conflictedFiles?: string[]
  sourceBranch?: string
  targetBranch?: string
  sourceWorkspaceId?: string
  targetWorkspaceId?: string
}

export interface MergeTeamRunMembersSummary {
  requested: number
  considered: number
  merged: number
  alreadyMerged: number
  wouldMerge: number
  skipped: number
  conflicts: number
  failed: number
}

export interface MergeTeamRunMembersResponse {
  teamRunId: string
  taskId: string
  projectId: string
  mainWorkspaceId: string | null
  dryRun: boolean
  stopOnConflict: boolean
  requestedWorkspaceIds?: string[]
  summary: MergeTeamRunMembersSummary
  results: MergeTeamRunMemberResult[]
}

/** 会话 */
export interface Session {
  id: string
  workspaceId?: string | null
  conversationId?: string | null
  context?: SessionContext | string
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

/** 独立对话 */
export interface Conversation {
  id: string
  title: string
  directoryName: string
  workingDir: string
  sessionId: string
  agentType: AgentType
  status: SessionStatus
  providerId?: string | null
  variant?: string | null
  tokenUsage?: { totalTokens: number; modelContextWindow?: number } | null
  deletedAt?: string | null
  lastActiveAt?: string
  createdAt?: string
  updatedAt?: string
}

export interface ConversationCreateInput {
  prompt: string
  providerId: string
  variant?: string
  attachmentIds?: string[]
}

export interface ConversationMessageInput {
  message: string
  providerId?: string
  attachmentIds?: string[]
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
  heartbeatTimeoutMinutes: number
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
  heartbeatTimeoutMinutes: number
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
  membershipStatus: TeamMemberMembershipStatus
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
  visibility: RoomMessageVisibility
  content: string
  contentPreview?: string
  contentMode?: RoomMessageContentMode
  /** 当前响应未包含全文时，是否可通过详情接口获取完整 content */
  fullContentAvailable?: boolean
  isTruncated?: boolean
  mentions: StructuredMention[]
  recipientMemberIds?: string[] | null
  participantMemberIds?: string[] | null
  participants?: RoomMessageParticipant[]
  workRequestIds?: string[] | null
  artifactRefs?: string[] | null
  attachmentIds?: string[] | null
  createdAt?: string
}

/** 私聊消息参与者 */
export interface RoomMessageParticipant {
  id: string
  teamRunId: string
  roomMessageId: string
  memberId: string
  role: RoomMessageParticipantRole
  createdAt?: string
}

/** 指向团队成员的一次工作请求 */
export interface WorkRequest {
  id: string
  teamRunId: string
  requesterMemberId?: string | null
  requesterType: WorkRequestRequesterType
  targetMemberId: string
  targetKind?: WorkRequestTargetKind | null
  targetPurpose?: WorkRequestTargetPurpose | null
  targetSourceWorkspaceId?: string | null
  targetSourceMemberId?: string | null
  targetHeadSha?: string | null
  targetBranchName?: string | null
  targetPlanItemId?: string | null
  triggerMessageId: string
  instruction: string
  instructionPreview?: string
  isTruncated?: boolean
  ifBusy: IfBusyPolicy
  cancelQueued: boolean
  status: WorkRequestStatus
  startAttemptCount: number
  lastStartError?: string | null
  nextStartRetryAt?: string | null
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
  targetKind?: WorkRequestTargetKind | null
  targetPurpose?: WorkRequestTargetPurpose | null
  targetSourceWorkspaceId?: string | null
  targetSourceMemberId?: string | null
  targetHeadSha?: string | null
  targetBranchName?: string | null
  targetPlanItemId?: string | null
  targetSyncStatus?: AgentInvocationTargetSyncStatus | null
  targetSyncError?: string | null
  targetExecutionBranch?: string | null
  targetPort?: number | null
  targetVitePort?: number | null
  targetE2EPort?: number | null
  status: AgentInvocationStatus
  roomReplyReminderCount: number
  nextRoomReplyReminderAt?: string | null
  lastHeartbeatAt?: string | null
  firstNudgeAt?: string | null
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

// ============ Agent CLI 环境引导 ============

export type AgentCliToolId = 'codex' | 'claude-code' | 'cursor-agent' | 'gemini-cli'

export type AgentCliPlatform = 'darwin' | 'linux' | 'win32'

export type AgentCliInstallKind = 'downloaded-script' | 'detect-only'

export interface AgentCliOfficialSource {
  label: string
  url: string
}

export interface AgentCliCommandSpec {
  command: string
  args: string[]
  timeoutMs: number
  versionPattern?: string
}

export interface AgentCliInterpreterSpec {
  command: string
  args: string[]
}

export interface AgentCliDownloadedScriptInstallSpec {
  downloadUrl: string
  allowedRedirectHosts: string[]
  allowedExactPaths: string[]
  allowedPathPrefixes: string[]
  scriptExtension: string
  interpreter: AgentCliInterpreterSpec
  fixedArgs: string[]
  env?: Record<string, string>
  maxBytes: number
  riskNotes: string[]
  verifyCommand: AgentCliCommandSpec
}

export interface AgentCliDownloadedScriptInstall {
  kind: 'downloaded-script'
  platforms: Partial<Record<AgentCliPlatform, AgentCliDownloadedScriptInstallSpec>>
}

export interface AgentCliDetectOnlyInstall {
  kind: 'detect-only'
  reason: string
}

export type AgentCliInstallPlan =
  | AgentCliDownloadedScriptInstall
  | AgentCliDetectOnlyInstall

export interface AgentCliInstallManifestItem {
  id: AgentCliToolId
  displayName: string
  description?: string
  legacy: boolean
  officialSources: AgentCliOfficialSource[]
  supportedPlatforms: AgentCliPlatform[]
  install: AgentCliInstallPlan
  detectionCommands: AgentCliCommandSpec[]
  versionCommand?: AgentCliCommandSpec
  authCommand?: AgentCliCommandSpec
  lastVerifiedAt: string
}

export type AgentCliPublicDownloadedScriptInstall =
  Omit<AgentCliDownloadedScriptInstall, 'platforms'> & {
    platforms: Partial<Record<AgentCliPlatform, Omit<AgentCliDownloadedScriptInstallSpec, 'verifyCommand'>>>
  }

export type AgentCliPublicInstallPlan =
  | AgentCliPublicDownloadedScriptInstall
  | AgentCliDetectOnlyInstall

export interface AgentCliPublicInstallManifestItem
  extends Omit<AgentCliInstallManifestItem, 'install'> {
  install: AgentCliPublicInstallPlan
}

export type AgentCliInstallStatus =
  | 'unknown'
  | 'installed'
  | 'missing'
  | 'unsupported'
  | 'legacy_detected'
  | 'error'

export type AgentCliVersionStatus = 'unknown' | 'detected' | 'unavailable' | 'error'

export type AgentCliAuthStatus =
  | 'unknown'
  | 'detected'
  | 'not_detected'
  | 'needs_interactive_login'
  | 'error'

export interface AgentCliToolStatus {
  toolId: AgentCliToolId
  installStatus: AgentCliInstallStatus
  versionStatus: AgentCliVersionStatus
  version: string | null
  authStatus: AgentCliAuthStatus
  checkedAt: string | null
  stale: boolean
  errorCode?: string
}

export interface AgentCliEnvironmentStatus {
  tools: AgentCliToolStatus[]
  checkedAt: string | null
  stale: boolean
}

export type AgentCliInstallPreviewStatus = 'ready' | 'expired' | 'consumed'

export interface AgentCliRedirectStep {
  url: string
  host: string
  path: string
  statusCode: number
}

export interface AgentCliInstallPreview {
  id: string
  toolId: AgentCliToolId
  platform: AgentCliPlatform
  status: AgentCliInstallPreviewStatus
  finalUrl: string
  redirectChain: AgentCliRedirectStep[]
  sizeBytes: number
  sha256: string
  interpreter: AgentCliInterpreterSpec
  fixedArgs: string[]
  env?: Record<string, string>
  riskNotes: string[]
  createdAt: string
  expiresAt: string
}

export type AgentCliInstallTaskStatus =
  | 'running'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelling'
  | 'cancelled'

export interface AgentCliInstallTask {
  id: string
  toolId: AgentCliToolId
  previewId: string
  status: AgentCliInstallTaskStatus
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
  signal: string | null
  errorCode?: string
  errorMessage?: string
}

export interface AgentCliCreateInstallTaskResponse {
  reused: boolean
  task: AgentCliInstallTask
}

export type AgentCliInstallLogSource = 'stdout' | 'stderr' | 'system'

export interface AgentCliInstallLogEntry {
  seq: number
  timestamp: string
  source: AgentCliInstallLogSource
  data: string
}

export interface AgentCliInstallLogResponse {
  taskId: string
  entries: AgentCliInstallLogEntry[]
  nextSeq: number
  truncated: boolean
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

/** 访问密码公开状态 */
export interface AccessAuthPublicStatus {
  enabled: boolean
  authenticated: boolean
}

/** 访问密码设置（不包含密码 hash） */
export interface AccessAuthSafeSettings {
  enabled: boolean
  passwordConfigured: boolean
  passwordUpdatedAt: string | null
}

/** 更新访问密码设置 */
export interface UpdateAccessAuthSettingsInput {
  enabled?: boolean
  currentPassword?: string
  newPassword?: string
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

// ============ MCP 配置 ============

export type McpConfigRuntimeMode = 'desktop-packaged' | 'workspace'

export interface McpConfigResponse {
  serverName: string
  runtimeMode: McpConfigRuntimeMode
  command: string
  args: string[]
  env: Record<string, string>
  config: {
    mcpServers: Record<string, {
      command: string
      args: string[]
      env?: Record<string, string>
    }>
  }
  configJson: string
}
