import { cn } from '@/lib/utils'

/**
 * 侧栏行（与主页左侧任务面板同一套几何）：
 * 行高 32px（触屏 40px）、字号 14px（触屏 15px）、外边距 8px + 内边距 8px，图标落在 16px 基线上。
 * 悬停浅灰底；选中是浮起的白卡（与右侧内容岛同材质，表达「正在右侧打开」）。
 */
export function navRowClassName(active: boolean, className?: string) {
  return cn(
    'flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-sm transition-[background-color,box-shadow,color] duration-150 pointer-coarse:h-10 pointer-coarse:text-[15px]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
    active
      ? 'bg-background text-foreground shadow-raised ring-1 ring-border/80'
      : 'text-foreground/80 hover:bg-accent hover:text-foreground active:bg-foreground/[0.06]',
    className,
  )
}
