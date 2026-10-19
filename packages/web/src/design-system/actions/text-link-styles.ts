import { cn } from '@/lib/utils'

/**
 * 句子里的链接：墨色文字 + 灰下划线，悬停时下划线加深。不用蓝色——蓝色只表示「运行中 / 信息」。
 * 跟着句子折行、继承字号；长网址可以在任意位置断开。Markdown 渲染器、路由 Link 直接用这个类名。
 */
export function textLinkClassName(className?: string) {
  return cn(
    'rounded text-foreground underline decoration-foreground/30 underline-offset-[3px] [overflow-wrap:anywhere]',
    'transition-[text-decoration-color] duration-150 hover:decoration-foreground/80',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
    className,
  )
}
