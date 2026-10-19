import * as React from "react"

import { Dialog, DialogContent } from "@/design-system"
import { cn } from "@/lib/utils"
import { useScrollLock } from "@/lib/scroll-lock"

export interface ModalProps {
  /** 控制 Modal 是否打开 */
  isOpen: boolean
  /** 关闭回调 */
  onClose: () => void
  /** 标题 */
  title: string
  /** 主体内容 */
  children: React.ReactNode
  /** 底部操作按钮区域 */
  action?: React.ReactNode
  /** 自定义容器类名 */
  className?: string
}

/**
 * 旧接口的对话框，内部是设计系统的 Dialog（Esc / 点遮罩关闭、焦点圈定、关闭后焦点归还）。
 * 新代码直接用 `@/design-system` 的 Dialog。
 */
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  action,
  className,
}) => {
  useScrollLock(isOpen)

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        title={title}
        footer={action}
        className={cn("max-w-lg", className)}
        // 和原来一样先聚焦面板本身，不抢到右上角的关闭按钮；带 autoFocus 的输入框不受影响
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const panel = event.currentTarget as HTMLElement | null
          panel?.focus()
        }}
      >
        {children}
      </DialogContent>
    </Dialog>
  )
}
