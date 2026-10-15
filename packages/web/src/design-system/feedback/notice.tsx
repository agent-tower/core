import type { ComponentProps, ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { TONE_MARK, type Tone } from '../tokens'

const TONE_ICON: Record<Tone, ReactNode> = {
  neutral: <Info />,
  info: <Info />,
  success: <CircleCheck />,
  warning: <TriangleAlert />,
  danger: <CircleAlert />,
}

/** 提示条底色：比徽章更淡，整行着色时不抢正文 */
const TONE_SURFACE: Record<Tone, string> = {
  neutral: 'bg-foreground/[0.04]',
  info: 'bg-info/[0.06]',
  success: 'bg-success/[0.07]',
  warning: 'bg-warning/[0.08]',
  danger: 'bg-destructive/[0.06]',
}

export interface NoticeProps extends Omit<ComponentProps<'div'>, 'title'> {
  tone?: Tone
  title?: ReactNode
  /** 自定义图标；传 false 不显示图标 */
  icon?: ReactNode | false
  /** 行尾操作，通常是一个 link 按钮 */
  action?: ReactNode
  onDismiss?: () => void
}

/**
 * 提示条：一段需要读到、但不打断操作的说明。
 * 颜色只给图标，正文保持墨色——整段彩色文字难读，也会和状态徽章抢注意力。
 * 需要立刻打断的错误用 Toast 或对话框，不要用提示条。
 */
export function Notice({ tone = 'neutral', title, icon, action, onDismiss, className, children, ...props }: NoticeProps) {
  const { t } = useI18n()
  return (
    <div
      data-slot="notice"
      className={cn('flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-[13px] leading-5', TONE_SURFACE[tone], className)}
      {...props}
    >
      {icon !== false && (
        <span aria-hidden="true" className={cn('mt-0.5 shrink-0 [&_svg]:size-4', TONE_MARK[tone])}>
          {icon ?? TONE_ICON[tone]}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {title && <div className="font-medium text-foreground">{title}</div>}
        {children && <div className={cn('text-foreground/80', title && 'mt-0.5')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('Dismiss')}
          className="-mr-1 shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
