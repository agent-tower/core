/**
 * Codex JSON 输出解析器
 * 将 Codex 的 JSONL 输出转换为标准化日志
 */

import type { MsgStore } from './msg-store.js';

const DEBUG_PARSER = process.env.DEBUG_PARSER === 'true';

import {
  type NormalizedEntry,
  type ToolStatus,
  type FileChange,
  type TodoItem,
  createAssistantMessage,
  createToolUse,
  createTokenUsageInfo,
  createErrorMessage,
} from './types.js';

import {
  EntryIndexProvider,
  addNormalizedEntry,
  replaceNormalizedEntry,
  updateEntryContent,
  updateToolStatus,
  setSessionId,
} from './utils/patch.js';

import { stripAnsiSequences } from './utils/ansi.js';

/**
 * Codex 事件类型
 */
interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  /** error 事件和 turn.failed 共用的消息字段 */
  message?: string;
  /** turn.failed 的 error 对象 */
  error?: {
    message?: string;
  };
}

interface CodexItem {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  /** file_change item: 变更文件列表 */
  changes?: Array<{ path?: string; kind?: string }>;
  /** todo_list item: 计划条目 */
  items?: Array<{ text?: string; completed?: boolean }>;
}

/**
 * Codex 解析器
 */
export class CodexParser {
  private msgStore: MsgStore;
  private buffer = '';
  private currentToolUseId: string | null = null;
  private currentToolIndex: number | null = null;
  private toolOutputBuffer = '';
  /** 收集非 JSON 行，用于进程异常退出时作为错误信息 */
  private nonJsonLines: string[] = [];
  /** 是否已通过 JSON 事件推送过错误（用于 finish 去重） */
  private hasJsonError = false;
  /** 已推送的错误消息集合（用于 error / turn.failed 去重） */
  private pushedErrors = new Set<string>();
  /** 重试类错误的 entry index（用于原地更新而非创建新条目） */
  private retryErrorIndex: number | null = null;
  /** 按 item.id upsert 的 entry（mcp_tool_call / file_change / todo_list）item.id -> entry index */
  private itemEntryMap = new Map<string, number>();
  private turnCompleted = false;
  private turnFailed = false;
  private turnCompletedListeners = new Set<() => void>();
  private turnFailedListeners = new Set<() => void>();

  constructor(msgStore: MsgStore) {
    this.msgStore = msgStore;
  }

  private get indexProvider() {
    return this.msgStore.entryIndex;
  }

  /** Subscribe to the successful logical-turn signal (emitted at most once). */
  onTurnCompleted(listener: () => void): () => void {
    this.turnCompletedListeners.add(listener);
    return () => this.turnCompletedListeners.delete(listener);
  }

  /** Subscribe to the failed logical-turn signal (emitted at most once). */
  onTurnFailed(listener: () => void): () => void {
    this.turnFailedListeners.add(listener);
    return () => this.turnFailedListeners.delete(listener);
  }

  /**
   * 处理数据流
   */
  processData(data: string): void {
    // Strip ANSI escape sequences before buffering. Windows ConPTY injects
    // cursor-control / screen-clear / OSC title sequences into the data
    // stream that would corrupt JSON parsing.
    this.buffer += stripAnsiSequences(data);

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 收集非 JSON 行（如 ERROR 日志），用于异常退出时展示
      if (!trimmed.startsWith('{')) {
        this.nonJsonLines.push(stripAnsiSequences(trimmed));
        if (DEBUG_PARSER) {
          console.log('[CodexParser] Skipping non-JSON line:', trimmed.substring(0, 100));
        }
        continue;
      }

      this.parseJsonSegments(trimmed);
    }
  }

  /**
   * 解析一行中可能包含的多个 JSON 对象
   * Codex 有时会在同一行输出多个 JSON: {"type":"error",...} {"type":"turn.failed",...}
   */
  private parseJsonSegments(line: string): void {
    // 尝试直接解析整行
    try {
      const event: CodexEvent = JSON.parse(line);
      this.handleEvent(event);
      return;
    } catch {
      // 可能是多个 JSON 拼接，尝试拆分
    }

    const segments = this.extractJsonObjects(line);

    for (const segment of segments) {
      try {
        const event: CodexEvent = JSON.parse(segment);
        this.handleEvent(event);
      } catch (err) {
        if (DEBUG_PARSER) {
          console.error('[CodexParser] Failed to parse JSON segment:', segment.substring(0, 200), err);
        }
      }
    }
  }

  /**
   * Extract complete top-level JSON objects from a line without splitting on
   * braces that appear inside JSON strings.
   */
  private extractJsonObjects(line: string): string[] {
    const segments: string[] = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];

      if (start === -1) {
        if (char === '{') {
          start = i;
          depth = 1;
          inString = false;
          escaped = false;
        }
        continue;
      }

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          segments.push(line.slice(start, i + 1));
          start = -1;
        }
      }
    }

    return segments;
  }

  /**
   * 处理事件
   */
  private handleEvent(event: CodexEvent): void {
    if (DEBUG_PARSER) {
      console.log('[CodexParser] Event:', event.type, event);
    }

    switch (event.type) {
      case 'thread.started':
        if (event.thread_id) {
          this.msgStore.pushSessionId(event.thread_id);
          const patch = setSessionId(event.thread_id);
          this.msgStore.pushPatch(patch);
        }
        break;

      case 'item.completed':
        this.handleItemCompleted(event);
        break;

      case 'item.started':
        this.handleItemStarted(event);
        break;

      case 'item.updated':
        this.handleItemUpdated(event);
        break;

      case 'turn.completed':
        if (!this.turnCompleted && !this.turnFailed) {
          if (event.usage) this.handleUsage(event.usage);
          this.turnCompleted = true;
          for (const listener of [...this.turnCompletedListeners]) listener();
        }
        break;

      case 'error':
        this.handleError(event.message || 'Unknown error');
        break;

      case 'turn.failed':
        if (this.turnCompleted || this.turnFailed) break;
        this.turnFailed = true;
        this.handleError(event.error?.message || event.message || 'Turn failed');
        for (const listener of [...this.turnFailedListeners]) listener();
        break;
    }
  }

  /**
   * 处理 item.updated 事件（如 todo_list 勾选进度）
   * 复用 upsert 语义：已存在则原地 replace，未见过则新增。
   */
  private handleItemUpdated(event: CodexEvent): void {
    const item = event.item;
    if (!item) return;

    if (item.type === 'mcp_tool_call') {
      this.upsertMcpToolEntry(item, this.getMcpToolStatus(item));
    } else if (item.type === 'file_change') {
      this.upsertFileChangeEntry(item);
    } else if (item.type === 'todo_list') {
      this.upsertTodoListEntry(item);
    }
  }

  /**
   * 处理 item.started 事件
   */
  private handleItemStarted(event: CodexEvent): void {
    const item = event.item;
    if (!item) return;

    if (item.type === 'mcp_tool_call') {
      this.upsertMcpToolEntry(item, this.getMcpToolStatus(item));
    } else if (item.type === 'file_change') {
      this.upsertFileChangeEntry(item);
    } else if (item.type === 'todo_list') {
      this.upsertTodoListEntry(item);
    } else if (item.type === 'command_execution' && item.command) {
      // 创建工具使用记录
      const toolUse = createToolUse(
        'bash',
        item.command,
        'command_run',
        undefined,
        item.id
      );
      const index = this.indexProvider.next();
      const patch = addNormalizedEntry(index, toolUse);
      this.msgStore.pushPatch(patch);
      this.currentToolUseId = item.id;
      this.currentToolIndex = index;
      this.toolOutputBuffer = '';
    }
  }

  /**
   * 处理 item.completed 事件
   */
  private handleItemCompleted(event: CodexEvent): void {
    const item = event.item;
    if (!item) return;

    if (item.type === 'agent_message' && item.text) {
      // Agent 消息
      const cleanText = stripAnsiSequences(item.text);
      const message = createAssistantMessage(cleanText);
      const index = this.indexProvider.next();
      const patch = addNormalizedEntry(index, message);
      this.msgStore.pushPatch(patch);
    } else if (item.type === 'mcp_tool_call') {
      this.upsertMcpToolEntry(item, this.getMcpToolStatus(item));
    } else if (item.type === 'file_change') {
      this.upsertFileChangeEntry(item);
    } else if (item.type === 'todo_list') {
      this.upsertTodoListEntry(item);
    } else if (item.type === 'command_execution') {
      if (this.currentToolUseId === item.id && this.currentToolIndex !== null) {
        const status = item.exit_code === 0 ? 'success' : 'failed';
        const patch = updateToolStatus(this.currentToolIndex, status);
        this.msgStore.pushPatch(patch);

        if (item.aggregated_output) {
          this.appendToolResultContent(this.currentToolIndex, stripAnsiSequences(item.aggregated_output));
        }

        this.currentToolUseId = null;
        this.currentToolIndex = null;
        this.toolOutputBuffer = '';
      }
    }
  }

  private upsertMcpToolEntry(item: CodexItem, status: ToolStatus): void {
    this.upsertItemEntry(item.id, this.createMcpToolEntry(item, status));
  }

  /**
   * 按 item.id upsert entry：同一 item 的 started/updated/completed 原地更新，
   * 避免长任务期间重复刷条目，同时保证每次状态变化都有 patch 推送到前端。
   */
  private upsertItemEntry(itemId: string, entry: NormalizedEntry): void {
    const existingIndex = this.itemEntryMap.get(itemId);

    if (existingIndex !== undefined) {
      const patch = replaceNormalizedEntry(existingIndex, entry);
      this.msgStore.pushPatch(patch);
      return;
    }

    const index = this.indexProvider.next();
    this.itemEntryMap.set(itemId, index);
    const patch = addNormalizedEntry(index, entry);
    this.msgStore.pushPatch(patch);
  }

  /**
   * file_change item → file_edit 工具 entry。
   * Codex 修改文件阶段可能持续很久，这些事件曾被丢弃，导致 UI 长时间零输出。
   */
  private upsertFileChangeEntry(item: CodexItem): void {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const fileChanges: FileChange[] = changes.flatMap((change): FileChange[] => {
      const path = typeof change?.path === 'string' ? change.path : '';
      if (!path) return [];
      const kind = change?.kind?.toLowerCase();
      if (kind === 'add') return [{ type: 'write', path }];
      if (kind === 'delete') return [{ type: 'delete', path }];
      return [{ type: 'edit', path }];
    });

    const summary = fileChanges.length > 0
      ? fileChanges
          .map((c) => ('path' in c ? `${c.type}: ${c.path}` : `${c.type}: ${c.from} → ${c.to}`))
          .join('\n')
      : 'File changes';

    const entry = createToolUse('apply_patch', summary, 'file_edit', item.id, item.id);
    this.upsertItemEntry(item.id, {
      ...entry,
      metadata: {
        ...entry.metadata,
        status: this.getMcpToolStatus(item),
        ...(fileChanges.length > 0 ? { fileChanges } : {}),
      },
    });
  }

  /**
   * todo_list item → todo_management entry（item.updated 勾选进度原地刷新）。
   */
  private upsertTodoListEntry(item: CodexItem): void {
    const items = Array.isArray(item.items) ? item.items : [];
    const todos: TodoItem[] = items.map((t) => ({
      content: typeof t?.text === 'string' ? stripAnsiSequences(t.text) : '',
      status: t?.completed ? 'completed' : 'pending',
    }));

    const summary = todos.length > 0
      ? todos.map((t) => `${t.status === 'completed' ? '[x]' : '[ ]'} ${t.content}`).join('\n')
      : 'Todo list';

    const entry = createToolUse('update_plan', summary, 'todo_management', item.id, item.id);
    this.upsertItemEntry(item.id, {
      ...entry,
      metadata: {
        ...entry.metadata,
        ...(todos.length > 0 ? { todos } : {}),
      },
    });
  }

  private createMcpToolEntry(item: CodexItem, status: ToolStatus): NormalizedEntry {
    const toolName = item.tool || 'mcp';
    const content = this.formatMcpToolContent(item);
    const entry = createToolUse(toolName, content, 'tool', item.id, item.id);

    return {
      ...entry,
      metadata: {
        ...entry.metadata,
        status,
      },
    };
  }

  private formatMcpToolContent(item: CodexItem): string {
    const target = item.server && item.tool ? `${item.server}/${item.tool}` : item.tool || item.server || 'mcp';
    const lines = [`MCP tool call: ${target}`];

    if (item.server) lines.push(`Server: ${item.server}`);
    if (item.tool) lines.push(`Tool: ${item.tool}`);
    if (item.status) lines.push(`Status: ${item.status}`);
    if (item.arguments !== undefined) lines.push(`Arguments: ${this.formatJsonValue(item.arguments)}`);
    if (item.result !== undefined && item.result !== null) lines.push(`Result: ${this.formatJsonValue(item.result)}`);
    if (item.error !== undefined && item.error !== null) lines.push(`Error: ${this.formatJsonValue(item.error)}`);

    return lines.join('\n');
  }

  private formatJsonValue(value: unknown): string {
    if (typeof value === 'string') {
      return stripAnsiSequences(value);
    }

    try {
      return stripAnsiSequences(JSON.stringify(value, null, 2));
    } catch {
      return stripAnsiSequences(String(value));
    }
  }

  private getMcpToolStatus(item: CodexItem): ToolStatus {
    const rawStatus = item.status?.toLowerCase();

    if (item.error != null) return 'failed';
    if (rawStatus === 'completed' || rawStatus === 'success' || rawStatus === 'succeeded') return 'success';
    if (rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'cancelled' || rawStatus === 'canceled') return 'failed';
    if (rawStatus === 'denied') return 'denied';
    if (rawStatus === 'pending_approval') return 'pending_approval';
    if (rawStatus === 'timed_out' || rawStatus === 'timeout') return 'timed_out';

    return 'created';
  }

  /**
   * 将工具结果追加到对应 entry 的 content 中
   */
  private appendToolResultContent(entryIndex: number, resultContent: string): void {
    const trimmed = resultContent.trim();
    if (!trimmed) return;

    const snapshot = this.msgStore.getSnapshot();
    const entry = snapshot.entries[entryIndex];
    if (!entry) return;

    const MAX_RESULT_LENGTH = 20_000;
    const truncated = trimmed.length > MAX_RESULT_LENGTH
      ? trimmed.slice(0, MAX_RESULT_LENGTH) + `\n... (truncated, ${trimmed.length} chars total)`
      : trimmed;

    const newContent = entry.content + '\n\n' + truncated;
    const patch = updateEntryContent(entryIndex, newContent);
    this.msgStore.pushPatch(patch);
  }

  /**
   * 处理 token 使用信息
   */
  private handleUsage(usage: CodexEvent['usage']): void {
    if (!usage) return;

    // 计算总 token 数：input_tokens + output_tokens
    // 注意：cached_input_tokens 是 input_tokens 的一部分，不应该额外相加
    const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);

    const tokenUsage = createTokenUsageInfo(totalTokens);

    const index = this.indexProvider.next();
    const patch = addNormalizedEntry(index, tokenUsage);
    this.msgStore.pushPatch(patch);
  }

  /**
   * 检测是否为重试类消息（如 "Reconnecting... 3/5 (reason)"）
   */
  private isRetryMessage(message: string): boolean {
    return /Reconnecting\.\.\.\s*\d+\/\d+/i.test(message);
  }

  /**
   * 处理错误事件（type: error / turn.failed）
   * - 重试类消息（Reconnecting... N/M）：原地更新同一个 entry
   * - 普通错误：去重后创建新 entry
   */
  private handleError(message: string): void {
    this.hasJsonError = true;

    if (this.isRetryMessage(message)) {
      if (this.retryErrorIndex !== null) {
        // 原地更新已有的重试 entry
        const patch = updateEntryContent(this.retryErrorIndex, message);
        this.msgStore.pushPatch(patch);
      } else {
        // 第一次重试：创建 entry 并记录 index
        const entry = createErrorMessage(message, message);
        const index = this.indexProvider.next();
        const patch = addNormalizedEntry(index, entry);
        this.msgStore.pushPatch(patch);
        this.retryErrorIndex = index;
      }
      return;
    }

    // 非重试消息：检查是否与最后一次重试的根因相同
    // 如 "Reconnecting... 5/5 (reason)" 之后紧跟 "reason" → 更新而非新建
    if (this.retryErrorIndex !== null) {
      const patch = updateEntryContent(this.retryErrorIndex, message);
      this.msgStore.pushPatch(patch);
      this.retryErrorIndex = null;
      this.pushedErrors.add(message);
      return;
    }

    // 普通去重
    if (this.pushedErrors.has(message)) return;
    this.pushedErrors.add(message);

    const entry = createErrorMessage(message, message);
    const index = this.indexProvider.next();
    const patch = addNormalizedEntry(index, entry);
    this.msgStore.pushPatch(patch);
  }

  /**
   * 完成解析
   * 幂等：残留 buffer 消费后立即清空。PTY exit 与 pipeline destroy 都会走到
   * finish，双调用不能把最后一段无换行输出重复解析成重复条目。
   */
  finish(exitCode?: number): void {
    const tail = this.buffer;
    this.buffer = '';
    if (tail.trim()) {
      this.parseJsonSegments(tail);
    }

    // 进程异常退出且没有通过 JSON 事件推送过错误时，才用 nonJsonLines 作为兜底
    const isFailed = typeof exitCode === 'number' && exitCode !== 0;
    if (isFailed && !this.hasJsonError && this.nonJsonLines.length > 0) {
      const errorText = this.nonJsonLines.join('\n').trim();
      if (errorText) {
        const entry = createErrorMessage(
          `Agent process exited with code ${exitCode}:\n${errorText}`,
          errorText
        );
        const index = this.indexProvider.next();
        const patch = addNormalizedEntry(index, entry);
        this.msgStore.pushPatch(patch);
      }
    }
  }
}

/**
 * 创建 Codex 解析器
 */
export function createCodexParser(msgStore: MsgStore): CodexParser {
  return new CodexParser(msgStore);
}
