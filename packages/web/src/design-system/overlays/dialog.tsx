import type { ComponentProps, ReactNode } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Button } from '../actions/button'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

const DIALOG_WIDTH = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-xl',
  xl: 'max-w-3xl',
} as const

export interface DialogContentProps extends Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> {
  title: ReactNode
  description?: ReactNode
  /** 底部操作区，主按钮放最右 */
  footer?: ReactNode
  size?: keyof typeof DIALOG_WIDTH
  hideClose?: boolean
}

/**
 * 对话框：需要用户专注完成的一件事（创建项目、确认删除）。
 * 遮罩用 20% 黑（与任务搜索浮层一致），面板白底 14px 圆角（rounded-xl）；Esc / 点遮罩关闭，焦点圈定并在关闭后归还。
 */
export function DialogContent({ title, description, footer, size = 'md', hideClose = false, className, children, ...props }: DialogContentProps) {
  const { t } = useI18n()
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/20 duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-[60] flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-overlay outline-none',
          'duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          DIALOG_WIDTH[size],
          className,
        )}
        {...(description ? {} : { 'aria-describedby': undefined })}
        {...props}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-5 pb-3 pt-5">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-[15px] font-semibold leading-6 text-foreground">{title}</DialogPrimitive.Title>
            {description && (
              <DialogPrimitive.Description className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          {!hideClose && (
            <DialogPrimitive.Close
              aria-label={t('Close')}
              className="-mr-1.5 -mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <X className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          )}
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 text-sm text-foreground/90">{children}</div>}
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 bg-foreground/[0.015] px-5 py-3">
            {footer}
          </div>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description: ReactNode
  confirmLabel: string
  cancelLabel: string
  /** danger：删除、终止等不可逆操作，主按钮变红并带警示图标 */
  tone?: 'neutral' | 'danger'
  loading?: boolean
  onConfirm: () => void
}

/** 确认框：二次确认一个操作。文案写清后果（「删除后无法恢复」），按钮写动作本身而不是「确定」 */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, cancelLabel, tone = 'neutral', loading = false, onConfirm }: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        hideClose
        title={
          <span className="flex items-center gap-2">
            {tone === 'danger' && (
              <span className="flex size-6 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <TriangleAlert className="size-3.5" aria-hidden="true" />
              </span>
            )}
            {title}
          </span>
        }
        description={description}
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => onOpenChange(false)} disabled={loading}>{cancelLabel}</Button>
            <Button variant="primary" tone={tone} size="md" loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
          </>
        }
      />
    </Dialog>
  )
}
