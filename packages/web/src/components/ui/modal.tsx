import * as React from "react"
import { useEffect, useCallback, useState } from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

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

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  action,
  className,
}) => {
  const [isVisible, setIsVisible] = useState(false)

  // 打开/关闭动画状态管理
  useEffect(() => {
    if (isOpen) {
      setIsVisible(true)
      document.body.style.overflow = "hidden"
    } else {
      const timer = setTimeout(() => setIsVisible(false), 200)
      document.body.style.overflow = "unset"
      return () => clearTimeout(timer)
    }
  }, [isOpen])

  // ESC 键关闭 — 使用全局事件监听 + useCallback 去重
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose()
      }
    },
    [onClose]
  )

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown)
      return () => {
        document.removeEventListener("keydown", handleKeyDown)
      }
    }
  }, [isOpen, handleKeyDown])

  // 未显示时不渲染 DOM
  if (!isVisible && !isOpen) return null

  // isOpen 三元运算符控制动画状态
  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-200",
        isOpen ? "opacity-100" : "opacity-0"
      )}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-white/80 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Content */}
      <div
        className={cn(
          "relative w-full max-w-lg bg-white rounded-xl shadow-2xl shadow-neutral-200/50 border border-neutral-100 transform transition-all duration-200",
          isOpen ? "scale-100 translate-y-0" : "scale-95 translate-y-2",
          className
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-50">
          <h3 className="font-semibold text-neutral-900">{title}</h3>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-900 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6">{children}</div>

        {/* Footer actions */}
        {action ? (
          <div className="px-6 py-4 bg-neutral-50 rounded-b-xl border-t border-neutral-100 flex justify-end gap-3">
            {action}
          </div>
        ) : null}
      </div>
    </div>
  )
}
