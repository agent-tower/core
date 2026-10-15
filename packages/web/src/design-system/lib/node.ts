import type { ReactNode } from 'react'

/**
 * 插槽是否有内容。`{count && <span>…</span>}` 在 count 为 0 时会把「0」原样渲染出来，
 * 计数、数值类的插槽统一用它判断：0 算内容，null / undefined / 布尔 / 空串不算。
 */
export function hasNode(node: ReactNode): boolean {
  return node !== null && node !== undefined && typeof node !== 'boolean' && node !== ''
}
