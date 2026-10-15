import { createContext, useContext } from 'react'

export interface FieldControlContext {
  id: string
  describedBy?: string
  invalid: boolean
  required: boolean
}

/** Field 把 id / 描述 / 错误态下发给内部控件，控件无需手动接线 */
export const FieldContext = createContext<FieldControlContext | null>(null)

export function useFieldControl() {
  return useContext(FieldContext)
}

/** 输入类控件共用的外壳：边框加深表达焦点，不引入彩色描边 */
export const FIELD_SHELL =
  'rounded-lg border border-input bg-background text-foreground transition-colors hover:border-ring/50'
export const FIELD_INVALID = 'border-destructive hover:border-destructive focus-within:border-destructive focus:border-destructive'
export const FIELD_DISABLED = 'cursor-not-allowed bg-muted/50 text-muted-foreground hover:border-input'
export const FIELD_SIZE = {
  sm: 'h-8 px-2.5 text-[13px]',
  md: 'h-9 px-3 text-sm',
} as const
