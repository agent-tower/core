import type { Tone } from '../tokens'

export type FileChangeStatus = 'A' | 'M' | 'D' | 'R'

/** 文件变更状态 → 语气：新增 success · 修改 warning · 删除 danger · 重命名 info */
export const FILE_CHANGE_TONE: Record<FileChangeStatus, Tone> = { A: 'success', M: 'warning', D: 'danger', R: 'info' }

/** Git 给的状态字母不止四种（U、C 等），认不出的按「修改」处理 */
export function fileChangeTone(status: string): Tone {
  return FILE_CHANGE_TONE[status as FileChangeStatus] ?? 'warning'
}
