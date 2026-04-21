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

import * as path from 'node:path'
import type { MsgStore } from './msg-store.js'
import type { ActionType, ToolStatus } from './types.js'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolUse,
  createThinking,
  createErrorMessage,
  createTokenUsageInfo,
} from './types.js'
import {
  EntryIndexProvider,
  addNormalizedEntry,
  replaceNormalizedEntry,
  updateEntryContent,
  updateToolStatus,
  setSessionId,
} from './utils/patch.js'
import { stripAnsiSequences } from './utils/ansi.js'

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

interface CursorJsonConnection {
  type: 'connection'
  subtype?: string
  session_id?: string
  timestamp_ms?: number
}

interface CursorJsonRetry {
  type: 'retry'
  subtype?: string
  session_id?: string
  timestamp_ms?: number
  attempt?: number
  is_resume?: boolean
  checkpoint_turn_count?: number
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

interface CursorJsonInteractionQuery {
  type: 'interaction_query'
  subtype: 'request' | 'response' | string
  query_type: string
  query?: {
    id: number
    webSearchRequestQuery?: {
      args: { searchTerm: string; toolCallId: string }
    }
    webFetchRequestQuery?: {
      args: { url: string; toolCallId: string }
      skipApproval?: boolean
    }
    [key: string]: unknown
  }
  response?: {
    id: number
    [key: string]: unknown
  }
  session_id?: string
  timestamp_ms?: number
}

type CursorJsonMessage =
  | CursorJsonSystem
  | CursorJsonUser
  | CursorJsonAssistant
  | CursorJsonThinking
  | CursorJsonConnection
  | CursorJsonRetry
  | CursorJsonToolCall
  | CursorJsonResult
  | CursorJsonInteractionQuery
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
  webSearchToolCall: 'web_search',
  webFetchToolCall: 'web_fetch',
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
 * 将路径转为相对路径（跨平台：处理大小写和不同分隔符）
 */
function makePathRelative(filePath: string, worktreePath: string): string {
  if (!worktreePath || !filePath) return filePath;
  const normFile = path.normalize(filePath);
  const normBase = path.normalize(worktreePath);
  const isWin = process.platform === 'win32';
  const fileForCmp = isWin ? normFile.toLowerCase() : normFile;
  const baseForCmp = isWin ? normBase.toLowerCase() : normBase;
  if (!fileForCmp.startsWith(baseForCmp)) return filePath;
  const relative = normFile.slice(normBase.length).replace(/^[\\/]/, '');
  return relative || filePath;
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
    web_search: 'search',
    web_fetch: 'web_fetch',
  };
  return mapping[toolName] || 'tool';
}

/**
 * Normalize Cursor todo status strings to standard format
 */
function normalizeTodoStatus(status: string): string {
  switch (status.toLowerCase()) {
    case 'todo_status_pending': return 'pending'
    case 'todo_status_in_progress': return 'in_progress'
    case 'todo_status_completed': return 'completed'
    case 'todo_status_cancelled': return 'cancelled'
    default: return status
  }
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
    case 'web_search':
      return String(args.searchTerm || 'search query');
    case 'web_fetch':
      return String(args.url || 'url');
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

// Debug 日志开关
const DEBUG_PARSER = process.env.DEBUG_PARSER === 'true' || false;

const CURSOR_AUTH_REQUIRED_MSG = "Authentication required. Please run 'cursor-agent login' first, or set CURSOR_API_KEY environment variable.";

/**
 * Cursor Agent 解析器
 * 解析 Cursor Agent CLI 的 stream-json (JSONL) 输出
 */
export class CursorAgentParser {
  private msgStore: MsgStore;
  private buffer: string = '';
  private worktreePath: string;

  // 流式合并状态
  private sessionIdReported = false;
  private modelReported = false;
  private currentAssistantBuffer: string = '';
  private currentAssistantIndex: number | null = null;
  private currentThinkingBuffer: string = '';
  private currentThinkingIndex: number | null = null;
  private lastAssistantIndex: number | null = null;
  private lastThinkingIndex: number | null = null;
  private retryEntryIndex: number | null = null;
  private retryEntryId: string | null = null;

  // 工具调用 call_id -> entry index 映射
  private callIndexMap: Map<string, number> = new Map();

  constructor(msgStore: MsgStore, worktreePath: string = '') {
    this.msgStore = msgStore;
    this.worktreePath = worktreePath;
  }

  /** 使用 MsgStore 共享的索引提供器 */
  private get indexProvider(): EntryIndexProvider {
    return this.msgStore.entryIndex;
  }

  /**
   * 处理原始输出数据（可能包含多行或不完整行）
   */
  processData(data: string): void {
    // Strip ANSI escape sequences before buffering. Windows ConPTY injects
    // cursor-control / screen-clear / OSC title sequences into the data
    // stream that would corrupt JSON parsing.
    const cleaned = stripAnsiSequences(data);
    this.buffer += cleaned;
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
    const content = stripAnsiSequences(data); // 去除 ANSI 转义

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
    if (this.parseJsonSegments(line)) {
      return;
    }

    // 非 JSON 行（PTY echo、ANSI 控制序列等）— 丢弃，不产出 entry
    // Agent CLI 的所有有效输出都是 JSONL 格式
    if (DEBUG_PARSER) {
      const stripped = stripAnsiSequences(line).trim();
      if (stripped) {
        console.log(`[CursorAgentParser] Skipping non-JSON line: "${stripped.slice(0, 80)}"`);
      }
    }
  }

  /**
   * 一行中可能包含多个 JSON 对象（Cursor 在 retry/resume 时偶尔会拼到同一行）
   */
  private parseJsonSegments(line: string): boolean {
    const trimmed = line.trim()
    if (!trimmed) return true

    try {
      const msg = JSON.parse(trimmed) as CursorJsonMessage
      this.handleMessage(msg, trimmed)
      return true
    } catch {
      // 可能是多个 JSON 拼接，继续拆分尝试
    }

    const segments = trimmed.split(/\}\s*\{/).map((seg, i, arr) => {
      if (arr.length === 1) return seg
      if (i === 0) return seg + '}'
      if (i === arr.length - 1) return '{' + seg
      return '{' + seg + '}'
    })

    let parsedCount = 0
    for (const segment of segments) {
      try {
        const msg = JSON.parse(segment) as CursorJsonMessage
        this.handleMessage(msg, segment)
        parsedCount += 1
      } catch {
        // ignore invalid segment; caller will log if none parsed
      }
    }

    return parsedCount > 0
  }

  /**
   * 处理已解析的 JSON 消息
   */
  private handleMessage(msg: CursorJsonMessage, rawLine: string): void {
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
    const isControlEvent = msg.type === 'connection' || msg.type === 'retry';

    if (!isAssistant && !isControlEvent && this.currentAssistantIndex !== null) {
      this.flushAssistant();
    }
    if (!isThinking && !isControlEvent && this.currentThinkingIndex !== null) {
      this.flushThinking();
    }

    // 分类处理
    switch (msg.type) {
      case 'system':
        this.handleSystem(msg as CursorJsonSystem);
        break;
      case 'user':
        this.handleUser(msg as CursorJsonUser);
        break;
      case 'assistant':
        this.handleAssistant(msg as CursorJsonAssistant);
        break;
      case 'thinking':
        this.clearRetryState();
        this.handleThinking(msg as CursorJsonThinking);
        break;
      case 'connection':
        this.handleConnection(msg as CursorJsonConnection);
        break;
      case 'retry':
        this.handleRetry(msg as CursorJsonRetry);
        break;
      case 'interaction_query':
        this.clearRetryState();
        this.handleInteractionQuery(msg as CursorJsonInteractionQuery);
        break;
      case 'tool_call':
        this.clearRetryState();
        this.handleToolCall(msg as CursorJsonToolCall);
        break;
      case 'result': {
        this.clearRetryState();
        // 从 result 消息中提取 token 用量（如果有）
        const resultMsg = msg as CursorJsonResult
        if (resultMsg.result && typeof resultMsg.result === 'object') {
          const result = resultMsg.result as Record<string, unknown>
          const usage = result.usage
          if (usage && typeof usage === 'object') {
            try {
              const u = usage as Record<string, number>
              const totalTokens =
                (u.input_tokens || u.inputTokens || 0) +
                (u.output_tokens || u.outputTokens || 0) +
                (u.cache_read_input_tokens || 0) +
                (u.cache_creation_input_tokens || 0)
              const modelContextWindow = u.context_window || u.model_context_window || undefined
              const entry = createTokenUsageInfo(totalTokens, modelContextWindow)
              const index = this.indexProvider.next()
              const patch = addNormalizedEntry(index, entry)
              this.msgStore.pushPatch(patch)
            } catch {
              // 提取失败静默跳过
            }
          }
        }
        break
      }
      default:
        // 未知类型 - 静默丢弃，避免将原始 JSON 暴露到对话界面
        if (DEBUG_PARSER) {
          console.log(`[CursorAgentParser] Unknown message type: ${(msg as { type?: string }).type ?? '(no type)'}`);
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
   * 处理 user 消息
   * 跳过 — 用户消息已由 SessionManager.sendMessage() 主动写入 MsgStore，
   * 这里如果再处理 Cursor Agent 的 user 回显会导致前端显示重复。
   */
  private handleUser(_msg: CursorJsonUser): void {
    // noop: avoid duplicating the user message already injected by SessionManager
  }

  /**
   * 处理连接状态消息
   * 这类事件仅用于底层重连控制，不应直接暴露到聊天流。
   */
  private handleConnection(_msg: CursorJsonConnection): void {
    // noop
  }

  /**
   * 处理重试状态消息
   * 使用单条可更新的 entry，避免把原始 JSON 暴露给前端。
   */
  private handleRetry(msg: CursorJsonRetry): void {
    this.beginReplayFromRetry()

    const entry = createErrorMessage(
      this.formatRetryContent(msg),
      this.formatRetryDetail(msg),
      this.retryEntryId ?? undefined
    )

    if (this.retryEntryIndex != null && this.retryEntryId != null) {
      const patch = replaceNormalizedEntry(this.retryEntryIndex, entry)
      this.msgStore.pushPatch(patch)
    } else {
      const index = this.indexProvider.next()
      const patch = addNormalizedEntry(index, entry)
      this.msgStore.pushPatch(patch)
      this.retryEntryIndex = index
      this.retryEntryId = entry.id
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
      this.lastAssistantIndex = this.currentAssistantIndex;
    } else {
      // 创建新条目
      const entry = createAssistantMessage(this.currentAssistantBuffer);
      const index = this.indexProvider.next();
      this.currentAssistantIndex = index;
      const patch = addNormalizedEntry(index, entry);
      this.msgStore.pushPatch(patch);
      this.lastAssistantIndex = index;
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
      this.lastThinkingIndex = this.currentThinkingIndex;
    } else {
      // 创建新条目
      const entry = createThinking(this.currentThinkingBuffer);
      const index = this.indexProvider.next();
      this.currentThinkingIndex = index;
      const patch = addNormalizedEntry(index, entry);
      this.msgStore.pushPatch(patch);
      this.lastThinkingIndex = index;
    }
  }

  /**
   * 处理 interaction_query 消息
   * cursor-agent 通过此事件发起 web_search / web_fetch 等需要宿主审批的工具调用。
   * - request 子类型：作为 tool_use "started" 入库，注册 toolCallId → index 映射
   * - response 子类型：noop（审批结果已在后续 tool_call/completed 中体现）
   */
  private handleInteractionQuery(msg: CursorJsonInteractionQuery): void {
    if (msg.subtype !== 'request' || !msg.query) return;

    const { query } = msg;

    let toolName: string;
    let content: string;
    let toolCallId: string | undefined;

    if (query.webSearchRequestQuery) {
      toolName = 'web_search';
      content = query.webSearchRequestQuery.args.searchTerm || 'search query';
      toolCallId = query.webSearchRequestQuery.args.toolCallId;
    } else if (query.webFetchRequestQuery) {
      toolName = 'web_fetch';
      content = query.webFetchRequestQuery.args.url || 'url';
      toolCallId = query.webFetchRequestQuery.args.toolCallId;
    } else {
      // 未知的 interaction_query 子类型 — 静默丢弃
      if (DEBUG_PARSER) {
        console.log(`[CursorAgentParser] Unknown interaction_query query_type: ${msg.query_type}`);
      }
      return;
    }

    const action = toolNameToAction(toolName);
    const entry = createToolUse(toolName, content, action, toolCallId);
    const index = this.indexProvider.next();

    if (toolCallId) {
      this.callIndexMap.set(toolCallId, index);
    }

    const patch = addNormalizedEntry(index, entry);
    this.msgStore.pushPatch(patch);
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
      // Extract todos if this is a todo tool call
      const extras = this.extractTodoExtras(toolName, tool_call);
      const entry = createToolUse(toolName, content, action, call_id, undefined, extras);
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
   * Extract todo items from Cursor's updateTodosToolCall
   */
  private extractTodoExtras(toolName: string, toolCall: CursorToolCall): { todos?: Array<{ content: string; status: string; priority?: string | null }>; todoOperation?: string } | undefined {
    if (toolName !== 'todo') return undefined;
    const args = getToolCallArgs(toolCall) as CursorUpdateTodosArgs;
    if (!args.todos || !Array.isArray(args.todos)) return undefined;
    return {
      todos: args.todos.map(t => ({
        content: t.content || '',
        status: normalizeTodoStatus(t.status || 'pending'),
        priority: null,
      })),
      todoOperation: 'write',
    };
  }

  /**
   * 收到 retry 时，后续 assistant/thinking 往往是从头重放。
   * 复用上一条 entry index，并从空 buffer 重新覆盖内容，避免出现重复消息。
   */
  private beginReplayFromRetry(): void {
    this.currentAssistantIndex = this.lastAssistantIndex
    this.currentAssistantBuffer = ''
    this.currentThinkingIndex = this.lastThinkingIndex
    this.currentThinkingBuffer = ''
  }

  private clearRetryState(): void {
    this.retryEntryIndex = null
    this.retryEntryId = null
  }

  private formatRetryContent(msg: CursorJsonRetry): string {
    const attemptSuffix = msg.attempt != null ? ` (attempt ${msg.attempt})` : ''
    const checkpointSuffix =
      msg.checkpoint_turn_count != null ? ` from checkpoint turn ${msg.checkpoint_turn_count}` : ''

    switch (msg.subtype?.toLowerCase()) {
      case 'starting':
        return `Connection lost, retrying request${attemptSuffix}...`
      case 'resuming':
        return `Resuming request${attemptSuffix}${checkpointSuffix}...`
      default:
        return `Retrying request${attemptSuffix}...`
    }
  }

  private formatRetryDetail(msg: CursorJsonRetry): string {
    const detail: string[] = []
    if (msg.subtype) detail.push(`subtype=${msg.subtype}`)
    if (msg.attempt != null) detail.push(`attempt=${msg.attempt}`)
    if (msg.is_resume != null) detail.push(`is_resume=${String(msg.is_resume)}`)
    if (msg.checkpoint_turn_count != null) detail.push(`checkpoint_turn_count=${msg.checkpoint_turn_count}`)
    return detail.join(', ')
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
