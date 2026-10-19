/**
 * 浮层菜单材质：下拉菜单、右键菜单、选择框、胶囊选择器共用一套。
 * 白底 + 1px 边框 + popover 阴影 + 10px 圆角（rounded-lg）；条目 8px 圆角（rounded-md），悬停浅灰，选中对勾统一在右侧。
 */

export const MENU_SURFACE =
  'z-[70] min-w-[12rem] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-popover outline-none duration-100 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95'

export const MENU_ITEM =
  "relative flex w-full cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground/80 outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:shrink-0"

/** 需要对勾指示的条目：右侧留出 24px */
export const MENU_ITEM_CHECKABLE = 'pr-7'

export const MENU_ITEM_DANGER =
  'text-destructive-ink data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive-ink'

export const MENU_INDICATOR = 'absolute right-2 flex size-3.5 items-center justify-center text-foreground'

export const MENU_LABEL = 'px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground'

export const MENU_SEPARATOR = '-mx-1 my-1 h-px bg-border/60'

export const MENU_SHORTCUT = 'ml-auto pl-4 text-[11px] tracking-wide text-muted-foreground'
