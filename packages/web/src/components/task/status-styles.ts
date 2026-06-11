/**
 * 任务状态 → 视觉样式 唯一映射字典
 *
 * 全站任务状态的颜色语义在此统一定义（见 .design/DESIGN.md §2.4），
 * 组件不得再散落硬编码状态颜色。
 */
import type { ComponentType } from 'react'
import { IconReview, IconRunning, IconPending, IconDone, IconCancelled } from '../agent/Icons'
import { UITaskStatus } from './types'

export interface StatusStyle {
  /** i18n key（与历史文案一致） */
  label: string
  icon: ComponentType<{ className?: string }>
  /** 列表/详情中状态图标颜色 */
  iconClass: string
  /** 菜单等场景中的强调色 */
  accentClass: string
}

export const STATUS_STYLES: Record<UITaskStatus, StatusStyle> = {
  [UITaskStatus.Review]: {
    label: 'Review',
    icon: IconReview,
    iconClass: 'text-warning',
    accentClass: 'text-warning',
  },
  [UITaskStatus.Running]: {
    label: 'Running',
    icon: IconRunning,
    iconClass: 'text-info',
    accentClass: 'text-info',
  },
  [UITaskStatus.Pending]: {
    label: 'Pending',
    icon: IconPending,
    iconClass: 'text-muted-foreground',
    accentClass: 'text-muted-foreground',
  },
  [UITaskStatus.Done]: {
    label: 'Done',
    icon: IconDone,
    iconClass: 'text-success/80',
    accentClass: 'text-success',
  },
  [UITaskStatus.Cancelled]: {
    label: 'Cancelled',
    icon: IconCancelled,
    iconClass: 'text-muted-foreground/70',
    accentClass: 'text-muted-foreground/70',
  },
}

/** 状态在菜单/分组中的展示顺序 */
export const STATUS_ORDER: UITaskStatus[] = [
  UITaskStatus.Review,
  UITaskStatus.Running,
  UITaskStatus.Pending,
  UITaskStatus.Done,
  UITaskStatus.Cancelled,
]
