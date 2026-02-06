/**
 * Cursor Agent stream-json 输出解析器
 * 将 Cursor Agent CLI 的 JSON 流输出转换为标准化日志
 *
 * 参考 vibe-kanban Rust 实现: crates/executors/src/executors/cursor.rs
 *
 * Cursor Agent 输出 JSONL 格式，每行一个 JSON 对象，包含以下类型：
 * - system: 系统初始化信息（model, session_id, cwd 等）
 * - user: 用户消息
 * - assistant: 助手文本消息（流式文本块）
 * - thinking: 思考过程
 * - tool_call: 工具调用（subtype: "started" | "completed"）
 * - result: 执行结果元数据
 */

import type { MsgStore } from './msg-store.js'
import type { ActionType, ToolStatus } from './types.js'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolUse,
  createThinking,
  createErrorMessage,
} from './types.js'
import {
  EntryIndexProvider,
  addNormalizedEntry,
  replaceNormalizedEntry,
  updateEntryContent,
  updateToolStatus,
  setSessionId,
} from './utils/patch.js'

// ============ Cursor JSON 类型定义 ============

/**
 * Cursor Agent 内容项
 */
interface CursorContentItem {
  type: 'text'
  text: string
}

/**
 * Cursor Agent 消息
 */
interface CursorMessage {
  role: string
  content: CursorContentItem[]
}

/**
 * Shell 工具参数
 */
interface CursorShellArgs {
  command: string
  working_directory?: string
  workingDirectory?: string
  timeout?: number
}

/**
 * LS 工具参数
 */
interface CursorLsArgs {
  path: string
  ignore?: string[]
}

/**
 * Glob 工具参数
 */
interface CursorGlobArgs {
  globPattern?: string
  glob_pattern?: string
  path?: string
  targetDirectory?: string
  target_directory?: string
}

/**
 * Grep 工具参数
 */
interface CursorGrepArgs {
  pattern: string
  path?: string
  glob?: string
  outputMode?: string
  output_mode?: string
}

/**
 * SemSearch 工具参数
 */
interface CursorSemSearchArgs {
  query: string
  targetDirectories?: string[]
  explanation?: string
}

/**
 * Write 工具参数
 */
interface CursorWriteArgs {
  path: string
  fileText?: string
  file_text?: string
  contents?: string
  content?: string
}

/**
 * Read 工具参数
 */
interface CursorReadArgs {
  path: string
  offset?: number
  limit?: number
}

/**
 * Edit 工具参数 - str_replace
 */
interface CursorStrReplace {
  oldText: string
  newText: string
  replaceAll?: boolean
}

/**
 * Edit 工具参数 - applyPatch
 */
interface CursorApplyPatch {
  patchContent: string
}

/**
 * Edit 工具参数 - multiStrReplace
 */
interface CursorMultiStrReplace {
  edits: Array<{
    oldText: string
    newText: string
    replaceAll?: boolean
  }>
}

/**
 * Edit 工具参数
 */
interface CursorEditArgs {
  path: string
  applyPatch?: CursorApplyPatch
  strReplace?: CursorStrReplace
  multiStrReplace?: CursorMultiStrReplace
}

/**
 * Delete 工具参数
 */
interface CursorDeleteArgs {
  path: string
}

/**
 * Todo 项
 */
interface CursorTodoItem {
  id?: string
  content: string
  status: string
}

/**
 * UpdateTodos 工具参数
 */
interface CursorUpdateTodosArgs {
  todos?: CursorTodoItem[]
}

/**
 * MCP 工具参数
 */
interface CursorMcpArgs {
  name: string
  args: unknown
  providerIdentifier?: string
  toolName?: string
}

/**
 * 工具调用 - 使用 Record 统一表示，通过 key 判断工具类型
 * Cursor Agent 的 tool_call.tool_call 字段结构：
 *   { "shellToolCall": { "args": {...}, "result": {...} } }
 *   { "readToolCall": { "args": {...}, "result": {...} } }
 *   等等
 */
type CursorToolCall = Record<string, unknown>

/**
 * Cursor JSON 消息类型
 */
interface CursorJsonSystem {
  type: 'system'
  subtype?: string
  apiKeySource?: string
  cwd?: string
  session_id?: string
  model?: string
  permissionMode?: string
}

interface CursorJsonUser {
  type: 'user'
  message: CursorMessage
  session_id?: string
}

interface CursorJsonAssistant {
  type: 'assistant'
  message: CursorMessage
  session_id?: string
}

interface CursorJsonThinking {
  type: 'thinking'
  subtype?: string
  text?: string
  session_id?: string
}

interface CursorJsonToolCall {
  type: 'tool_call'
  subtype?: string
  call_id?: string
  tool_call: CursorToolCall
  session_id?: string
}

interface CursorJsonResult {
  type: 'result'
  subtype?: string
  is_error?: boolean
  duration_ms?: number
  result?: unknown
  session_id?: string
}

type CursorJsonMessage =
  | CursorJsonSystem
  | CursorJsonUser
  | CursorJsonAssistant
  | CursorJsonThinking
  | CursorJsonToolCall
  | CursorJsonResult
  | { type: string; [key: string]: unknown } // Unknown

// ============ 工具调用解析辅助函数 ============

/** 工具 key -> 标准名称映射 */
const TOOL_KEY_MAP: Record<string, string> = {
  shellToolCall: 'shell',
  lsToolCall: 'ls',
  globToolCall: 'glob',
  grepToolCall: 'grep',
  semSearchToolCall: 'semsearch',
  writeToolCall: 'write',
  readToolCall: 'read',
  editToolCall: 'edit',
  deleteToolCall: 'delete',
  updateTodosToolCall: 'todo',
  mcpToolCall: 'mcp',
};

/**
 * 安全获取工具调用内部对象 { args, result }
 */
function getToolCallInner(toolCall: CursorToolCall): { key: string; inner: Record<string, unknown> } | null {
  for (const key of Object.keys(toolCall)) {
    if (key in TOOL_KEY_MAP) {
      const inner = toolCall[key];
      if (inner && typeof inner === 'object') {
        return { key, inner: inner as Record<string, unknown> };
      }
    }
  }
  return null;
}

/**
 * 安全获取 args 对象
 */
function getToolCallArgs(toolCall: CursorToolCall): Record<string, unknown> {
  const info = getToolCallInner(toolCall);
  if (info?.inner?.args && typeof info.inner.args === 'object') {
    return info.inner.args as Record<string, unknown>;
  }
  return {};
}

/**
 * 获取工具调用名称
 */
function getToolCallName(toolCall: CursorToolCall): string {
  const info = getToolCallInner(toolCall);
  if (info) {
    return TOOL_KEY_MAP[info.key] || info.key;
  }
  // Fallback: 返回第一个 key
  const keys = Object.keys(toolCall);
  return keys[0] || 'unknown';
}

/**
 * 将路径转为相对路径
 */
function makePathRelative(filePath: string, worktreePath: string): string {
  if (!worktreePath || !filePath) return filePath;
  if (filePath.startsWith(worktreePath)) {
    let relative = filePath.slice(worktreePath.length);
    if (relative.startsWith('/')) {
      relative = relative.slice(1);
    }
    return relative || filePath;
  }
  return filePath;
}

/**
 * 工具名称到动作类型的映射
 */
function toolNameToAction(toolName: string): ActionType {
  const mapping: Record<string, ActionType> = {
    shell: 'command_run',
    read: 'file_read',
    write: 'file_edit',
    edit: 'file_edit',
    delete: 'file_edit',
    grep: 'search',
    glob: 'search',
    semsearch: 'search',
    ls: 'other',
    todo: 'todo_management',
    mcp: 'tool',
  };
  return mapping[toolName] || 'tool';
}

/**
 * 获取工具调用的内容描述
 */
function getToolCallContent(toolCall: CursorToolCall, worktreePath: string): string {
  const name = getToolCallName(toolCall);
  const args = getToolCallArgs(toolCall);

  switch (name) {
    case 'shell':
      return String(args.command || 'command');
    case 'read':
      return makePathRelative(String(args.path || 'file'), worktreePath);
    case 'write':
      return makePathRelative(String(args.path || 'file'), worktreePath);
    case 'edit':
      return makePathRelative(String(args.path || 'file'), worktreePath);
    case 'delete':
      return makePathRelative(String(args.path || 'file'), worktreePath);
    case 'grep':
      return String(args.pattern || 'pattern');
    case 'semsearch':
      return String(args.query || 'query');
    case 'glob': {
      const pattern = String(args.globPattern || args.glob_pattern || '*');
      const targetPath = args.path || args.targetDirectory || args.target_directory;
      if (targetPath) {
        return `Find files: \`${pattern}\` in ${makePathRelative(String(targetPath), worktreePath)}`;
      }
      return `Find files: \`${pattern}\``;
    }
    case 'ls': {
      const lsPath = makePathRelative(String(args.path || ''), worktreePath);
      return lsPath ? `List directory: ${lsPath}` : 'List directory';
    }
    case 'todo':
      return 'TODO list updated';
    case 'mcp':
      return String(args.toolName || args.name || 'mcp');
    default:
      return name;
  }
}

/**
 * 从 CursorJson 消息中提取 session_id
 */
function extractSessionId(msg: CursorJsonMessage): string | undefined {
  // system 消息可能还没有初始化 session，不提取
  if (msg.type === 'system') return undefined;
  return (msg as { session_id?: string }).session_id || undefined;
}

/**
 * 连接 CursorMessage 中的所有文本内容
 */
function concatMessageText(message: CursorMessage): string | null {
  let out = '';
  for (const item of message.content) {
    if (item.type === 'text' && item.text) {
      out += item.text;
    }
  }
  return out || null;
}

// ============ Cursor Agent 解析器 ============

const CURSOR_AUTH_REQUIRED_MSG = "Authentication required. Please run 'cursor-agent login' first, or set CURSOR_API_KEY environment variable.";

/**
 * Cursor Agent 解析器
 * 解析 Cursor Agent CLI 的 stream-json (JSONL) 输出
 */
export class CursorAgentParser {
  private msgStore: MsgStore;
  private indexProvider: EntryIndexProvider;
  private buffer: string = '';
  private worktreePath: string;

  // 流式合并状态
  private sessionIdReported = false;
  private modelReported = false;
  private currentAssistantBuffer: string = '';
  private currentAssistantIndex: number | null = null;
  private currentThinkingBuffer: string = '';
  private currentThinkingIndex: number | null = null;

  // 工具调用 call_id -> entry index 映射
  private callIndexMap: Map<string, number> = new Map();

  constructor(msgStore: MsgStore, worktreePath: string = '') {
    this.msgStore = msgStore;
    this.indexProvider = new EntryIndexProvider();
    this.worktreePath = worktreePath;
  }

  /**
   * 处理原始输出数据（可能包含多行或不完整行）
   */
  processData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        this.parseLine(line);
      }
    }
  }

  /**
   * 处理 stderr 数据
   */
  processStderr(data: string): void {
    const content = data.replace(/\x1b\[[0-9;]*m/g, ''); // 去除 ANSI 转义

    if (content.includes(CURSOR_AUTH_REQUIRED_MSG)) {
      // 认证错误 - 创建 setup_required 错误
      const entry = createErrorMessage(content, 'setup_required');
      const index = this.indexProvider.next();
      const patch = addNormalizedEntry(index, entry);
      this.msgStore.pushPatch(patch);
    } else if (content.trim()) {
      // 普通 stderr 消息
      const entry = createErrorMessage(content);
      const index = this.indexProvider.next();
      const patch = addNormalizedEntry(index, entry);
      this.msgStore.pushPatch(patch);
    }
  }

  /**
   * 解析单行 JSON
   */
  private parseLine(line: string): void {
    let msg: CursorJsonMessage;
    try {
      msg = JSON.parse(line) as CursorJsonMessage;
    } catch {
      // 非 JSON 行，作为系统消息输出
      if (line.trim()) {
        const entry = createSystemMessage(line);
        const index = this.indexProvider.next();
        const patch = addNormalizedEntry(index, entry);
        this.msgStore.pushPatch(patch);
      }
      return;
    }

    // 推送 session_id
    if (!this.sessionIdReported) {
      const sessionId = extractSessionId(msg);
      if (sessionId) {
        this.msgStore.pushSessionId(sessionId);
        const patch = setSessionId(sessionId);
        this.msgStore.pushPatch(patch);
        this.sessionIdReported = true;
      }
    }

    // 判断是否需要刷新 assistant / thinking 缓冲区
    const isAssistant = msg.type === 'assistant';
    const isThinking = msg.type === 'thinking';

    if (!isAssistant && this.currentAssistantIndex !== null) {
      this.flushAssistant();
    }
    if (!isThinking && this.currentThinkingIndex !== null) {
      this.flushThinking();
    }

    // 分类处理
    switch (msg.type) {
      case 'system':
        this.handleSystem(msg as CursorJsonSystem);
        break;
      case 'user':
        // 用户消息不做处理（与 Rust 实现一致）
        break;
      case 'assistant':
        this.handleAssistant(msg as CursorJsonAssistant);
        break;
      case 'thinking':
        this.handleThinking(msg as CursorJsonThinking);
        break;
      case 'tool_call':
        this.handleToolCall(msg as CursorJsonToolCall);
        break;
      case 'result':
        // result 消息不做处理（仅元数据，与 Rust 实现一致）
        break;
      default:
        // 未知类型 - 作为系统消息输出
        {
          const entry = createSystemMessage(line);
          const index = this.indexProvider.next();
          const patch = addNormalizedEntry(index, entry);
          this.msgStore.pushPatch(patch);
        }
        break;
    }
  }

  /**
   * 处理 system 消息
   */
  private handleSystem(msg: CursorJsonSystem): void {
    if (!this.modelReported && msg.model) {
      const entry = createSystemMessage(`System initialized with model: ${msg.model}`);
      const index = this.indexProvider.next();
      const patch = addNormalizedEntry(index, entry);
      this.msgStore.pushPatch(patch);
      this.modelReported = true;
    }
  }

  /**
   * 处理 assistant 消息（流式文本块合并）
   */
  private handleAssistant(msg: CursorJsonAssistant): void {
    const chunk = concatMessageText(msg.message);
    if (!chunk) return;

    this.currentAssistantBuffer += chunk;

    if (this.currentAssistantIndex !== null) {
      // 更新现有条目
      const patch = updateEntryContent(this.currentAssistantIndex, this.currentAssistantBuffer);
      this.msgStore.pushPatch(patch);
    } else {
      // 创建新条目
      const entry = createAssistantMessage(this.currentAssistantBuffer);
      const index = this.indexProvider.next();
      this.currentAssistantIndex = index;
      const patch = addNormalizedEntry(index, entry);
      this.msgStore.pushPatch(patch);
    }
  }

  /**
   * 处理 thinking 消息（流式思考块合并）
   */
  private handleThinking(msg: CursorJsonThinking): void {
    if (!msg.text) return;

    this.currentThinkingBuffer += msg.text;

    if (this.currentThinkingIndex !== null) {
      // 更新现有条目
      const patch = updateEntryContent(this.currentThinkingIndex, this.currentThinkingBuffer);
      this.msgStore.pushPatch(patch);
    } else {
      // 创建新条目
      const entry = createThinking(this.currentThinkingBuffer);
      const index = this.indexProvider.next();
      this.currentThinkingIndex = index;
      const patch = addNormalizedEntry(index, entry);
      this.msgStore.pushPatch(patch);
    }
  }

  /**
   * 处理 tool_call 消息
   */
  private handleToolCall(msg: CursorJsonToolCall): void {
    const { subtype, call_id, tool_call } = msg;
    const toolName = getToolCallName(tool_call);
    const action = toolNameToAction(toolName);
    const content = getToolCallContent(tool_call, this.worktreePath);

    if (subtype?.toLowerCase() === 'started') {
      // 工具调用开始
      const entry = createToolUse(toolName, content, action, call_id);
      const index = this.indexProvider.next();

      if (call_id) {
        this.callIndexMap.set(call_id, index);
      }

      const patch = addNormalizedEntry(index, entry);
      this.msgStore.pushPatch(patch);
    } else if (subtype?.toLowerCase() === 'completed' && call_id) {
      // 工具调用完成 - 更新状态
      const existingIndex = this.callIndexMap.get(call_id);
      if (existingIndex !== undefined) {
        const patch = updateToolStatus(existingIndex, 'success' as ToolStatus);
        this.msgStore.pushPatch(patch);
      }
    }
  }

  /**
   * 刷新 assistant 缓冲区
   */
  private flushAssistant(): void {
    this.currentAssistantIndex = null;
    this.currentAssistantBuffer = '';
  }

  /**
   * 刷新 thinking 缓冲区
   */
  private flushThinking(): void {
    this.currentThinkingIndex = null;
    this.currentThinkingBuffer = '';
  }

  /**
   * 完成解析
   */
  finish(): void {
    // 处理剩余缓冲区
    if (this.buffer.trim()) {
      this.parseLine(this.buffer);
    }
    this.flushAssistant();
    this.flushThinking();
  }
}

/**
 * 创建 Cursor Agent 解析器
 */
export function createCursorAgentParser(msgStore: MsgStore, worktreePath: string = ''): CursorAgentParser {
  return new CursorAgentParser(msgStore, worktreePath);
}
