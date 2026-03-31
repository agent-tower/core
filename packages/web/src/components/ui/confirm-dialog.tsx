import * as React from "react"
import { AlertTriangle } from "lucide-react"
import { Modal } from "./modal"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n"

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
  const isDanger = variant === "danger"

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      className="max-w-sm"
      action={
        <>
          <button
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-neutral-600 hover:text-neutral-900 transition-colors disabled:opacity-50"
          >
            {t(cancelText)}
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className={cn(
              "px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50",
              isDanger
                ? "bg-red-500 text-white hover:bg-red-600"
                : "bg-neutral-900 text-white hover:bg-black"
            )}
          >
            {isLoading ? t("处理中...") : t(confirmText)}
          </button>
        </>
      }
    >
      <div className="flex gap-4">
        {isDanger && (
          <div className="shrink-0 w-10 h-10 rounded-full bg-red-50 flex items-center justify-center">
            <AlertTriangle size={20} className="text-red-500" />
          </div>
        )}
        <div className="text-sm text-neutral-600 leading-relaxed pt-1">{description}</div>
      </div>
    </Modal>
  )
}
