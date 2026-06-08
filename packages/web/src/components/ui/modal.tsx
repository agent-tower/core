import * as React from "react"
import { useEffect, useRef, useState } from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import { acquireScrollLock, releaseScrollLock } from "@/lib/scroll-lock"

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
  const lockedRef = useRef(false)

  useEffect(() => {
    if (isOpen) {
      setIsVisible(true)
      if (!lockedRef.current) {
        acquireScrollLock()
        lockedRef.current = true
      }
    } else {
      const timer = setTimeout(() => setIsVisible(false), 200)
      if (lockedRef.current) {
        releaseScrollLock()
        lockedRef.current = false
      }
      return () => clearTimeout(timer)
    }
  }, [isOpen])

  useEffect(() => {
    return () => {
      if (lockedRef.current) {
        releaseScrollLock()
        lockedRef.current = false
      }
    }
  }, [])

  if (!isVisible && !isOpen) return null

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-200",
        isOpen ? "opacity-100" : "opacity-0"
      )}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-white/80 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Content — tabIndex for keyboard event capture */}
      <div
        ref={(el) => { if (el && isOpen) el.focus() }}
        tabIndex={-1}
        className={cn(
          "relative flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden bg-white rounded-xl shadow-2xl shadow-neutral-200/50 border border-neutral-100 transform transition-all duration-200 outline-none",
          isOpen ? "scale-100 translate-y-0" : "scale-95 translate-y-2",
          className
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between px-6 py-4 border-b border-neutral-50">
          <h3 className="font-semibold text-neutral-900">{title}</h3>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-900 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-6">{children}</div>

        {/* Footer actions */}
        {action ? (
          <div className="shrink-0 px-6 py-4 bg-neutral-50 rounded-b-xl border-t border-neutral-100 flex justify-end gap-3">
            {action}
          </div>
        ) : null}
      </div>
    </div>
  )
}
