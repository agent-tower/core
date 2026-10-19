import * as React from "react"
import { Select as DesignSystemSelect, type SelectOption as DesignSystemSelectOption } from "@/design-system"
import { useI18n } from "@/lib/i18n"

export interface SelectOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
  icon?: React.ReactNode
}

export interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
}

/** Radix 不接受空字符串作为选项值，空值选项在内部换成这个占位值 */
const EMPTY_VALUE = "__empty__"
const NO_OPTIONS_VALUE = "__no_options__"

/**
 * 旧接口的选择框，内部是设计系统的 Select（浮层与菜单同材质，选中项加粗 + 对勾）。
 * 新代码直接用 `@/design-system` 的 Select。
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = "Select...",
  disabled = false,
  className,
}: SelectProps) {
  const { t } = useI18n()
  const isKnownValue = options.some(option => option.value === value)
  const items: DesignSystemSelectOption[] = options.length > 0
    ? options.map(option => ({ ...option, value: option.value === "" ? EMPTY_VALUE : option.value }))
    : [{ value: NO_OPTIONS_VALUE, label: t("No options"), disabled: true }]

  return (
    <DesignSystemSelect
      options={items}
      // 值不在选项里时传空串，Radix 显示占位文字（与原来一致）
      value={isKnownValue ? (value === "" ? EMPTY_VALUE : value) : ""}
      onValueChange={next => onChange(next === EMPTY_VALUE ? "" : next)}
      placeholder={t(placeholder)}
      disabled={disabled}
      className={className}
    />
  )
}
