/**
 * 任务状态 → 视觉样式 唯一映射字典
 *
 * 全站任务状态的颜色语义在此统一定义（设计系统 README 指定这里为唯一来源），
 * 组件不得再散落硬编码状态颜色。
 */
import type { ComponentType } from 'react'
import { CircleCheck, CircleDashed, CircleSlash, Eye, LoaderCircle } from 'lucide-react'
import { UITaskStatus } from './types'

export interface StatusStyle {
  /** i18n key（与历史文案一致） */
  label: string
  /** lucide 线性图标，与侧栏菜单同一套笔触；不带默认尺寸，调用方用 size-* 指定 */
  icon: ComponentType<{ className?: string }>
  /** 列表/详情中状态图标颜色 */
  iconClass: string
  /** 菜单等场景中的强调色 */
  accentClass: string
  /**
   * 侧栏任务行标题样式。行首不放状态图标（状态由分组标题表达），
   * 标题按「多需要用户介入」分级：待审查加粗、进行中扫光、已结束降灰
   */
  titleClass: string
}

export const STATUS_STYLES: Record<UITaskStatus, StatusStyle> = {
  [UITaskStatus.Review]: {
    label: 'Review',
    icon: Eye,
    iconClass: 'text-warning',
    accentClass: 'text-warning',
    // 600 而非 500：微软雅黑、Noto Sans CJK 常见安装都没有 500，会退回常规体
    titleClass: 'font-semibold text-foreground',
  },
  [UITaskStatus.Running]: {
    label: 'Running',
    icon: LoaderCircle,
    iconClass: 'text-info',
    accentClass: 'text-info',
    titleClass: 'task-title-running',
  },
  [UITaskStatus.Pending]: {
    label: 'Pending',
    icon: CircleDashed,
    iconClass: 'text-muted-foreground',
    accentClass: 'text-muted-foreground',
    titleClass: '',
  },
  [UITaskStatus.Done]: {
    label: 'Done',
    icon: CircleCheck,
    iconClass: 'text-success/80',
    accentClass: 'text-success',
    titleClass: 'text-muted-foreground',
  },
  [UITaskStatus.Cancelled]: {
    label: 'Cancelled',
    icon: CircleSlash,
    iconClass: 'text-muted-foreground/70',
    accentClass: 'text-muted-foreground/70',
    // 正文灰不再叠透明度，保证 4.5:1
    titleClass: 'text-muted-foreground',
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
