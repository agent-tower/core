import * as React from "react"
import { ConfirmDialog as DesignSystemConfirmDialog } from "@/design-system"
import { useI18n } from "@/lib/i18n"
import { useScrollLock } from "@/lib/scroll-lock"

export interface ConfirmDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description: React.ReactNode
  confirmText?: string
  cancelText?: string
  variant?: "danger" | "default"
  isLoading?: boolean
}

/**
 * 旧接口的确认框，内部是设计系统的 ConfirmDialog（danger 时主按钮变红并带警示图标，提交中转圈）。
 * 新代码直接用 `@/design-system` 的 ConfirmDialog。
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = "确认",
  cancelText = "取消",
  variant = "default",
  isLoading = false,
}) => {
  const { t } = useI18n()
  useScrollLock(isOpen)

  return (
    <DesignSystemConfirmDialog
      open={isOpen}
      onOpenChange={(open) => { if (!open) onClose() }}
      title={title}
      description={description}
      confirmLabel={t(confirmText)}
      cancelLabel={t(cancelText)}
      tone={variant === "danger" ? "danger" : "neutral"}
      loading={isLoading}
      onConfirm={onConfirm}
    />
  )
}
