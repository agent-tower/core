/**
 * 左侧任务面板的行样式（菜单项、分组标题、任务行共用）
 *
 * 统一网格：行外边距 8px + 内边距 8px，图标与分组标题都落在 16px 基线上。
 * 交互态：hover 灰底；选中为白卡（与右侧内容岛同一材质，表达「正在右侧打开」）；
 * 键盘焦点用中性灰焦点环（见 .design/DESIGN.md §7）。
 */
import { cn } from '@/lib/utils'

const SIDEBAR_ROW_BASE =
  'flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-sm text-left transition-[background-color,box-shadow,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60'

/** 行高：精确指针 32px；触屏放大到 40px 便于点按 */
const SIDEBAR_ROW_HEIGHT = 'h-8 pointer-coarse:h-10'

export function sidebarRowClass(isActive: boolean) {
  return cn(
    SIDEBAR_ROW_BASE,
    SIDEBAR_ROW_HEIGHT,
    isActive
      ? 'bg-background text-foreground shadow-xs ring-1 ring-border/80'
      : 'text-foreground/80 hover:bg-accent hover:text-foreground active:bg-foreground/[0.06]',
  )
}
