import type { ComponentProps, ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { hasNode } from '../lib/node'
import { navRowClassName } from './nav-row-styles'

interface NavRowContentProps {
  icon?: ReactNode
  label: ReactNode
  /** 右侧元信息：计数、时间、快捷键。必须紧凑，不能挤压标题宽度 */
  meta?: ReactNode
}

function NavRowContent({ icon, label, meta }: NavRowContentProps) {
  return (
    <>
      {icon && <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hasNode(meta) && <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground">{meta}</span>}
    </>
  )
}

export interface NavRowProps extends Omit<ComponentProps<'button'>, 'children'>, NavRowContentProps {
  active?: boolean
}

export function NavRow({ icon, label, meta, active = false, className, type, ...props }: NavRowProps) {
  return (
    <button
      type={type ?? 'button'}
      data-sidebar-item=""
      aria-current={active || undefined}
      className={navRowClassName(active, className)}
      {...props}
    >
      <NavRowContent icon={icon} label={label} meta={meta} />
    </button>
  )
}

export interface NavRowLinkProps extends Omit<LinkProps, 'children'>, NavRowContentProps {
  active?: boolean
}

/** 路由跳转版本（react-router Link） */
export function NavRowLink({ icon, label, meta, active = false, className, ...props }: NavRowLinkProps) {
  return (
    <Link
      data-sidebar-item=""
      aria-current={active ? 'page' : undefined}
      className={navRowClassName(active, typeof className === 'string' ? className : undefined)}
      {...props}
    >
      <NavRowContent icon={icon} label={label} meta={meta} />
    </Link>
  )
}
