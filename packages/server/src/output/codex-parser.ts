/**
 * Codex JSON 输出解析器
 * 将 Codex 的 JSONL 输出转换为标准化日志
 */

import type { MsgStore } from './msg-store.js';

const DEBUG_PARSER = process.env.DEBUG_PARSER === 'true';

import {
  createAssistantMessage,
  createToolUse,
  createTokenUsageInfo,
  createErrorMessage,
} from './types.js';

import {
  EntryIndexProvider,
  addNormalizedEntry,
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
  item?: {
    id: string;
    type: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
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

  constructor(msgStore: MsgStore) {
    this.msgStore = msgStore;
  }

  private get indexProvider() {
    return this.msgStore.entryIndex;
  }

  /**
   * 处理数据流
   */
  processData(data: string): void {
    this.buffer += data;

    // 按行分割
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

    // 按 `} {` 模式拆分（Codex 输出的多 JSON 行以空格分隔）
    const segments = line.split(/\}\s*\{/).map((seg, i, arr) => {
      if (arr.length === 1) return seg;
      if (i === 0) return seg + '}';
      if (i === arr.length - 1) return '{' + seg;
      return '{' + seg + '}';
    });

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

      case 'turn.completed':
        if (event.usage) {
          this.handleUsage(event.usage);
        }
        break;

      case 'error':
        this.handleError(event.message || 'Unknown error');
        break;

      case 'turn.failed':
        this.handleError(event.error?.message || event.message || 'Turn failed');
        break;
    }
  }

  /**
   * 处理 item.started 事件
   */
  private handleItemStarted(event: CodexEvent): void {
    const item = event.item;
    if (!item) return;

    if (item.type === 'command_execution' && item.command) {
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
    } else if (item.type === 'command_execution') {
      // 命令执行完成
      if (this.currentToolUseId === item.id && this.currentToolIndex !== null) {
        const status = item.exit_code === 0 ? 'success' : 'failed';
        const patch = updateToolStatus(this.currentToolIndex, status);
        this.msgStore.pushPatch(patch);

        this.currentToolUseId = null;
        this.currentToolIndex = null;
        this.toolOutputBuffer = '';
      }
    }
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
   */
  finish(exitCode?: number): void {
    if (this.buffer.trim()) {
      this.parseJsonSegments(this.buffer);
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
