import * as React from "react"
import { Slot } from "radix-ui"

import { buttonClassName, type ButtonSize as DesignSystemButtonSize, type ButtonVariant as DesignSystemButtonVariant } from "@/design-system"

type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"
type ButtonSize = "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg"

/** 旧变体 → 设计系统的按钮：default 是主按钮，outline 是描边白卡，secondary 是浅灰底 */
const VARIANT: Record<ButtonVariant, { variant: DesignSystemButtonVariant; tone?: "danger" }> = {
  default: { variant: "primary" },
  destructive: { variant: "primary", tone: "danger" },
  outline: { variant: "secondary" },
  secondary: { variant: "soft" },
  ghost: { variant: "ghost" },
  link: { variant: "link" },
}

/** 旧尺寸 → 设计系统的高度档位（24 / 28 / 32 / 36 / 44），高度保持不变；原来 40px 的 lg 归到 44 */
const SIZE: Record<ButtonSize, { size: DesignSystemButtonSize; iconOnly?: boolean }> = {
  default: { size: "lg" },
  xs: { size: "xs" },
  sm: { size: "md" },
  lg: { size: "xl" },
  icon: { size: "lg", iconOnly: true },
  "icon-xs": { size: "xs", iconOnly: true },
  "icon-sm": { size: "md", iconOnly: true },
  "icon-lg": { size: "xl", iconOnly: true },
}

/**
 * 旧接口的按钮，样式来自设计系统的 buttonClassName。
 * 不设默认 type：表单里的按钮仍按原生行为提交。新代码直接用 `@/design-system` 的 Button。
 */
function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & {
  variant?: ButtonVariant | null
  size?: ButtonSize | null
  asChild?: boolean
}) {
  const Comp = asChild ? Slot.Root : "button"
  const resolvedVariant = variant ?? "default"
  const resolvedSize = size ?? "default"

  return (
    <Comp
      data-slot="button"
      data-variant={resolvedVariant}
      data-size={resolvedSize}
      className={buttonClassName({ ...VARIANT[resolvedVariant], ...SIZE[resolvedSize], className })}
      {...props}
    />
  )
}

export { Button }
