import { cn } from '@/lib/utils'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'soft' | 'link'
export type ButtonTone = 'neutral' | 'danger'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

const BASE =
  "relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium outline-none transition-[background-color,color,box-shadow,opacity] duration-150 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0"

/** 高度档位与主页对齐：24 紧凑 · 28 胶囊/工具栏 · 32 列表行同高（默认）· 36 表单 · 44 首屏 CTA */
const SIZE: Record<ButtonSize, string> = {
  xs: "h-6 gap-1 rounded-md px-2 text-[11px] [&_svg:not([class*='size-'])]:size-3",
  sm: "h-7 gap-1.5 rounded-md px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
  md: "h-8 gap-1.5 rounded-md px-3 text-[13px] [&_svg:not([class*='size-'])]:size-4",
  lg: "h-9 gap-2 rounded-lg px-4 text-sm [&_svg:not([class*='size-'])]:size-4",
  xl: "h-11 gap-2 rounded-lg px-5 text-sm [&_svg:not([class*='size-'])]:size-4",
}

const ICON_SIZE: Record<ButtonSize, string> = {
  xs: "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
  sm: "size-7 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
  md: "size-8 rounded-lg [&_svg:not([class*='size-'])]:size-4",
  lg: "size-9 rounded-lg [&_svg:not([class*='size-'])]:size-[18px]",
  xl: "size-11 rounded-lg [&_svg:not([class*='size-'])]:size-5",
}

const VARIANT: Record<ButtonVariant, Record<ButtonTone, string>> = {
  primary: {
    neutral: 'bg-primary text-primary-foreground shadow-raised hover:bg-primary/90 active:bg-primary/85',
    danger: 'bg-destructive-ink text-white shadow-raised hover:bg-destructive-ink/90 active:bg-destructive-ink/85',
  },
  secondary: {
    neutral: 'bg-background text-foreground shadow-raised ring-1 ring-inset ring-border hover:bg-accent active:bg-foreground/[0.06]',
    danger: 'bg-background text-destructive-ink shadow-raised ring-1 ring-inset ring-destructive/25 hover:bg-destructive/[0.06] active:bg-destructive/10',
  },
  ghost: {
    neutral: 'text-foreground/80 hover:bg-accent hover:text-foreground active:bg-foreground/[0.06]',
    danger: 'text-destructive-ink hover:bg-destructive/10 active:bg-destructive/15',
  },
  soft: {
    neutral: 'bg-foreground/[0.05] text-foreground/90 hover:bg-foreground/[0.08] active:bg-foreground/10',
    danger: 'bg-destructive/10 text-destructive-ink hover:bg-destructive/15 active:bg-destructive/20',
  },
  link: {
    neutral: 'h-auto rounded-sm px-0 text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground/50',
    danger: 'h-auto rounded-sm px-0 text-destructive-ink underline decoration-destructive/30 underline-offset-4 hover:decoration-destructive/60',
  },
}

/** 图标按钮的 ghost 默认更安静：灰色图标，悬停才变成正文色 */
const ICON_GHOST = 'text-muted-foreground hover:bg-accent hover:text-foreground active:bg-foreground/[0.06] data-[state=open]:bg-accent data-[state=open]:text-foreground'

export interface ButtonStyleOptions {
  variant?: ButtonVariant
  tone?: ButtonTone
  size?: ButtonSize
  block?: boolean
  iconOnly?: boolean
  /** 提交中：同样不可点，但保持原色——转圈本身就说明了状态，不该看起来像「不可用」 */
  loading?: boolean
  className?: string
}

export function buttonClassName({
  variant = 'secondary',
  tone = 'neutral',
  size = 'md',
  block = false,
  iconOnly = false,
  loading = false,
  className,
}: ButtonStyleOptions = {}) {
  return cn(
    BASE,
    iconOnly ? ICON_SIZE[size] : SIZE[size],
    iconOnly && variant === 'ghost' && tone === 'neutral' ? ICON_GHOST : VARIANT[variant][tone],
    block && 'w-full',
    loading && 'disabled:opacity-100',
    className,
  )
}
