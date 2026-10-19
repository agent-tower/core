import type { CSSProperties, ReactNode } from 'react'
import { ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useControllableState } from '../lib/hooks'
import { Kbd } from '../actions/kbd'
import { Spinner } from '../feedback/spinner'

export interface ComposerProps {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  onSubmit?: (value: string) => void
  placeholder?: string
  /** 提交按钮的读屏名称，如「创建并启动」 */
  submitLabel: string
  /** 可提交时 ⏎ 后面的动作提示 */
  submitHint?: ReactNode
  submitting?: boolean
  /** 提交中的进度文案，如「正在创建工作区…」 */
  pendingLabel?: ReactNode
  disabled?: boolean
  /** 工具栏左侧：附件等 */
  toolbarStart?: ReactNode
  /** 工具栏右侧、提交按钮之前：上传进度、校验提示 */
  toolbarEnd?: ReactNode
  /** 卡片下方的胶囊行：项目、Agent、工作区等参数 */
  footer?: ReactNode
  autoFocus?: boolean
  'aria-label'?: string
  className?: string
}

/**
 * 输入卡（主页「你需要在 X 中做点什么？」）：一句话发起任务或对话。
 * 14px 圆角白卡 + raised 阴影；悬停 / 聚焦时边框逐级加深。
 * Enter 提交、Shift+Enter 换行，输入法组字时不提交。参数用卡片下方的胶囊选择器，不塞进卡片里。
 */
export function Composer({
  value,
  defaultValue = '',
  onValueChange,
  onSubmit,
  placeholder,
  submitLabel,
  submitHint,
  submitting = false,
  pendingLabel,
  disabled = false,
  toolbarStart,
  toolbarEnd,
  footer,
  autoFocus,
  className,
  ...props
}: ComposerProps) {
  const [text, setText] = useControllableState({ value, defaultValue, onChange: onValueChange })
  const canSubmit = text.trim().length > 0 && !disabled && !submitting

  const submit = () => {
    if (canSubmit) onSubmit?.(text)
  }

  return (
    <div data-slot="composer" className={cn('w-full', className)}>
      <div
        className={cn(
          'relative rounded-xl border border-border bg-background shadow-raised transition-colors duration-200',
          'hover:border-ring/40 focus-within:border-ring/60',
          submitting && 'opacity-80',
        )}
      >
        <textarea
          value={text}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={placeholder}
          aria-label={props['aria-label'] ?? placeholder}
          disabled={disabled || submitting}
          autoFocus={autoFocus}
          rows={1}
          className="block w-full resize-none border-none bg-transparent px-4 pb-2 pt-4 text-[15px] leading-relaxed text-foreground placeholder:text-muted-foreground/80 focus:outline-none disabled:cursor-not-allowed"
          style={{ minHeight: 76, maxHeight: 220, fieldSizing: 'content' } as CSSProperties}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
          <div className="flex min-w-0 items-center gap-1">{toolbarStart}</div>
          <div className="flex shrink-0 items-center gap-2">
            {submitting && pendingLabel && <Spinner size="sm" label={pendingLabel} className="text-xs" />}
            {toolbarEnd}
            {canSubmit && submitHint && (
              <span className="hidden select-none items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
                <Kbd>⏎</Kbd>
                {submitHint}
              </span>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              aria-label={submitLabel}
              title={submitLabel}
              className={cn(
                'flex size-8 items-center justify-center rounded-lg transition-all duration-200',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1',
                canSubmit
                  ? 'bg-primary text-primary-foreground shadow-raised hover:bg-primary/90'
                  : 'cursor-not-allowed bg-muted text-muted-foreground/40',
              )}
            >
              <ArrowUp size={16} strokeWidth={2.5} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      {footer && <div className="mt-2.5 flex flex-wrap items-center gap-1.5 px-0.5">{footer}</div>}
    </div>
  )
}
