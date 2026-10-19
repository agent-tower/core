import type { ComponentProps, ReactNode } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { ContextMenu as ContextMenuPrimitive, DropdownMenu as MenuPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'
import {
  MENU_INDICATOR,
  MENU_ITEM,
  MENU_ITEM_CHECKABLE,
  MENU_ITEM_DANGER,
  MENU_LABEL,
  MENU_SEPARATOR,
  MENU_SHORTCUT,
  MENU_SURFACE,
} from './menu-styles'

/* ── 下拉菜单 ─────────────────────────────────────────────── */

export const Menu = MenuPrimitive.Root
export const MenuTrigger = MenuPrimitive.Trigger
export const MenuGroup = MenuPrimitive.Group
export const MenuRadioGroup = MenuPrimitive.RadioGroup
export const MenuSub = MenuPrimitive.Sub

export function MenuContent({ className, sideOffset = 6, align = 'start', collisionPadding = 8, ...props }: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={collisionPadding}
        className={cn(MENU_SURFACE, 'origin-(--radix-dropdown-menu-content-transform-origin)', className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}

export interface MenuItemProps extends ComponentProps<typeof MenuPrimitive.Item> {
  icon?: ReactNode
  shortcut?: ReactNode
  tone?: 'neutral' | 'danger'
}

/** 菜单项：图标 14px 灰色在前、快捷键在后；删除类用 danger，并放在最后一组 */
export function MenuItem({ icon, shortcut, tone = 'neutral', className, children, ...props }: MenuItemProps) {
  return (
    <MenuPrimitive.Item className={cn(MENU_ITEM, tone === 'danger' && MENU_ITEM_DANGER, className)} {...props}>
      {icon && <span className={cn('flex shrink-0', tone === 'danger' ? 'text-current' : 'text-muted-foreground')}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className={MENU_SHORTCUT}>{shortcut}</span>}
    </MenuPrimitive.Item>
  )
}

export function MenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem className={cn(MENU_ITEM, MENU_ITEM_CHECKABLE, className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <MenuPrimitive.ItemIndicator className={MENU_INDICATOR}>
        <Check className="size-3.5" />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.CheckboxItem>
  )
}

export function MenuRadioItem({ icon, className, children, ...props }: ComponentProps<typeof MenuPrimitive.RadioItem> & { icon?: ReactNode }) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(MENU_ITEM, MENU_ITEM_CHECKABLE, 'data-[state=checked]:font-medium data-[state=checked]:text-foreground', className)}
      {...props}
    >
      {icon && <span className="flex shrink-0 text-muted-foreground">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <MenuPrimitive.ItemIndicator className={MENU_INDICATOR}>
        <Check className="size-3.5" />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.RadioItem>
  )
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn(MENU_LABEL, className)} {...props} />
}

export function MenuSeparator({ className, ...props }: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn(MENU_SEPARATOR, className)} {...props} />
}

export function MenuSubTrigger({ icon, className, children, ...props }: ComponentProps<typeof MenuPrimitive.SubTrigger> & { icon?: ReactNode }) {
  return (
    <MenuPrimitive.SubTrigger className={cn(MENU_ITEM, 'data-[state=open]:bg-accent', className)} {...props}>
      {icon && <span className="flex shrink-0 text-muted-foreground">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
    </MenuPrimitive.SubTrigger>
  )
}

export function MenuSubContent({ className, collisionPadding = 8, ...props }: ComponentProps<typeof MenuPrimitive.SubContent>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent className={cn(MENU_SURFACE, className)} sideOffset={4} collisionPadding={collisionPadding} {...props} />
    </MenuPrimitive.Portal>
  )
}

/* ── 右键菜单（同一材质，触发方式不同） ───────────────────── */

export const ContextMenu = ContextMenuPrimitive.Root
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger

export function ContextMenuContent({ className, collisionPadding = 8, ...props }: ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content className={cn(MENU_SURFACE, 'w-48 min-w-0', className)} collisionPadding={collisionPadding} {...props} />
    </ContextMenuPrimitive.Portal>
  )
}

export function ContextMenuItem({ icon, shortcut, tone = 'neutral', className, children, ...props }: ComponentProps<typeof ContextMenuPrimitive.Item> & { icon?: ReactNode; shortcut?: ReactNode; tone?: 'neutral' | 'danger' }) {
  return (
    <ContextMenuPrimitive.Item className={cn(MENU_ITEM, tone === 'danger' && MENU_ITEM_DANGER, className)} {...props}>
      {icon && <span className={cn('flex shrink-0', tone === 'danger' ? 'text-current' : 'text-muted-foreground')}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className={MENU_SHORTCUT}>{shortcut}</span>}
    </ContextMenuPrimitive.Item>
  )
}

export function ContextMenuLabel({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Label>) {
  return <ContextMenuPrimitive.Label className={cn(MENU_LABEL, className)} {...props} />
}

export function ContextMenuSeparator({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator className={cn(MENU_SEPARATOR, className)} {...props} />
}
