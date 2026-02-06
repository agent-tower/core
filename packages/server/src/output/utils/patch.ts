/**
 * JSON Patch 工具函数
 * 用于创建对话状态的增量更新
 */

import type { JsonPatch, NormalizedEntry, ToolStatus } from '../types.js'

/**
 * 条目索引提供器
 * 管理对话条目的递增索引
 */
export class EntryIndexProvider {
  private index: number

  constructor(startFrom = 0) {
    this.index = startFrom
  }

  next(): number {
    return this.index++
  }

  current(): number {
    return this.index
  }

  startFrom(index: number): void {
    this.index = index
  }
}

/**
 * 添加标准化条目
 */
export function addNormalizedEntry(index: number, entry: NormalizedEntry): JsonPatch {
  return [
    {
      op: 'add',
      path: `/entries/${index}`,
      value: entry,
    },
  ]
}

/**
 * 替换标准化条目
 */
export function replaceNormalizedEntry(index: number, entry: NormalizedEntry): JsonPatch {
  return [
    {
      op: 'replace',
      path: `/entries/${index}`,
      value: entry,
    },
  ]
}

/**
 * 更新条目内容
 */
export function updateEntryContent(index: number, content: string): JsonPatch {
  return [
    {
      op: 'replace',
      path: `/entries/${index}/content`,
      value: content,
    },
  ]
}

/**
 * 更新工具状态
 */
export function updateToolStatus(index: number, status: ToolStatus): JsonPatch {
  return [
    {
      op: 'replace',
      path: `/entries/${index}/metadata/status`,
      value: status,
    },
  ]
}

/**
 * 设置会话 ID
 */
export function setSessionId(sessionId: string): JsonPatch {
  return [
    {
      op: 'add',
      path: '/sessionId',
      value: sessionId,
    },
  ]
}

/**
 * 移除条目
 */
export function removeEntry(index: number): JsonPatch {
  return [
    {
      op: 'remove',
      path: `/entries/${index}`,
    },
  ]
}

/**
 * 合并多个 patch
 */
export function mergePatches(...patches: JsonPatch[]): JsonPatch {
  return patches.flat()
}

/**
 * ConversationPatch 工具对象
 */
export const ConversationPatch = {
  addNormalizedEntry,
  replaceNormalizedEntry,
  updateEntryContent,
  updateToolStatus,
  setSessionId,
  removeEntry,
  mergePatches,
}
