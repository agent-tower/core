// 任务状态
export enum TaskStatus {
  TODO = 'TODO',
  IN_PROGRESS = 'IN_PROGRESS',
  IN_REVIEW = 'IN_REVIEW',
  DONE = 'DONE',
  CANCELLED = 'CANCELLED',
}

// 工作空间状态
export enum WorkspaceStatus {
  ACTIVE = 'ACTIVE',
  MERGED = 'MERGED',
  ABANDONED = 'ABANDONED',
  HIBERNATED = 'HIBERNATED',
}

// 工作空间存储模式
export enum WorkspaceKind {
  WORKTREE = 'WORKTREE',
  MAIN_DIRECTORY = 'MAIN_DIRECTORY',
}

// AI 代理类型
export enum AgentType {
  CLAUDE_CODE = 'CLAUDE_CODE',
  GEMINI_CLI = 'GEMINI_CLI',
  CURSOR_AGENT = 'CURSOR_AGENT',
  CODEX = 'CODEX',
}

// 会话状态
export enum SessionStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

// 会话用途
export enum SessionPurpose {
  /** 正常用户交互会话 */
  CHAT = 'CHAT',
  /** 内部：生成 commit message */
  COMMIT_MSG = 'COMMIT_MSG',
}

// 会话执行上下文
export enum SessionContext {
  WORKSPACE = 'WORKSPACE',
  CONVERSATION = 'CONVERSATION',
}

// 代理可用性检查结果
export interface AgentAvailability {
  available: boolean;
  version?: string;
  error?: string;
}

// 执行器配置
export interface ExecutorConfig {
  workingDir: string;
  prompt: string;
  env?: Record<string, string>;
}
