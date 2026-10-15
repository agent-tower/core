import type { ComponentProps, ReactNode } from 'react'
import { TaskPriority } from '@agent-tower/shared'
import { STATUS_STYLES } from '@/components/task/status-styles'
import { getTaskPriorityOption } from '@/components/task/task-priority'
import { UITaskStatus } from '@/components/task/types'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '../feedback/badge'
import { NavGroup } from '../navigation/nav-group'
import { navRowClassName } from '../navigation/nav-row-styles'
import type { Tone } from '../tokens'
import { ProjectTag } from './tags'
import { RelativeTime } from './time'

/**
 * 任务状态的颜色与图标来自业务侧唯一映射（components/task/status-styles）：lucide 线性图标，
 * 与侧栏菜单同一套笔触。这里只负责排版（默认 16px），不另立一套状态色，也不加动画——
 * 「正在运行」由任务标题的扫光表达。
 */
export function TaskStatusIcon({ status, className }: { status: UITaskStatus; className?: string }) {
  const { icon: Icon, iconClass } = STATUS_STYLES[status]
  return <Icon className={cn('size-4 shrink-0', iconClass, className)} />
}

/** 状态标签：图标 + 文字，状态永远不只靠颜色表达 */
export function TaskStatusBadge({ status, className }: { status: UITaskStatus; className?: string }) {
  const { t } = useI18n()
  const { label } = STATUS_STYLES[status]
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-foreground/80 [&_svg]:size-3.5', className)}>
      <TaskStatusIcon status={status} />
      {t(label)}
    </span>
  )
}

const PRIORITY_TONE: Record<number, Tone> = {
  [TaskPriority.URGENT]: 'danger',
  [TaskPriority.HIGH]: 'warning',
  [TaskPriority.NORMAL]: 'neutral',
  [TaskPriority.LOW]: 'neutral',
}

/** 优先级：P0–P3 编号小标签。普通优先级在列表里默认不显示，只有偏离常态才值得占位 */
export function PriorityTag({ priority, showLabel = false, className }: { priority?: number; showLabel?: boolean; className?: string }) {
  const { t } = useI18n()
  const option = getTaskPriorityOption(priority)
  const tone = PRIORITY_TONE[option.value] ?? 'neutral'
  return (
    <Badge
      tone={tone}
      size="sm"
      shape="tag"
      title={`${option.code} · ${t(option.label)}`}
      className={cn('font-semibold', option.value === TaskPriority.LOW && 'bg-foreground/[0.04]', className)}
    >
      {option.code}
      {showLabel && <span className="font-medium">{t(option.label)}</span>}
    </Badge>
  )
}

export interface TaskRowProps extends Omit<ComponentProps<'button'>, 'title'> {
  title: string
  status: UITaskStatus
  priority?: number
  project?: { name: string; color: string }
  updatedAt?: Date | number | string
  /** 固定「现在」（测试、静态展示），透传给 RelativeTime */
  now?: number
  active?: boolean
}

/**
 * 任务行（主页左侧任务面板）：标题 + 优先级 + 元信息（项目 · 时间）。
 * 行首不放状态图标——状态由分组标题表达（TaskStatusGroup），宽度全部留给标题；
 * 标题按「多需要你介入」分级：待审查加粗、进行中淡扫光、已完成 / 已取消降灰（STATUS_STYLES.titleClass）。
 * 元信息必须紧凑，悬停 / 键盘聚焦时整体收起（.task-row-meta）；侧栏过窄（< 22rem）时项目标签自动隐藏。
 * 需放在 @container 容器内。
 */
export function TaskRow({ title, status, priority, project, updatedAt, now, active = false, className, ...props }: TaskRowProps) {
  const { titleClass } = STATUS_STYLES[status]
  return (
    <button
      type="button"
      data-sidebar-item=""
      aria-current={active || undefined}
      title={project ? `${title} · ${project.name}` : title}
      className={cn('task-row', navRowClassName(active), className)}
      {...props}
    >
      <span className={cn('min-w-0 flex-1 truncate', titleClass)}>{title}</span>
      {priority !== undefined && priority !== TaskPriority.NORMAL && <PriorityTag priority={priority} />}
      {(project || updatedAt !== undefined) && (
        <span className="task-row-meta">
          <span className="flex items-center gap-1">
            {project && <ProjectTag name={project.name} color={project.color} className="@max-[22rem]:hidden" />}
            {updatedAt !== undefined && <RelativeTime value={updatedAt} now={now} className="text-[11px]" />}
          </span>
        </span>
      )}
    </button>
  )
}

export interface TaskStatusGroupProps {
  status: UITaskStatus
  count: number
  defaultOpen?: boolean
  /** 标题吸顶（默认开）。滚动容器请加 scroll-pt-8，键盘 ↑/↓ 聚焦的行不会被标题挡住 */
  sticky?: boolean
  children: ReactNode
  className?: string
}

/**
 * 任务分组（主页左侧任务面板）：状态图标每组只在标题出现一次，任务行不再重复；待审查的计数用 warning
 * 提示需要介入。展开且有任务时下方留 16px（组内行距 1px），只靠间距就能分出组界。
 */
export function TaskStatusGroup({ status, count, defaultOpen = true, sticky = true, children, className }: TaskStatusGroupProps) {
  const { t } = useI18n()
  const { icon: Icon, label, accentClass } = STATUS_STYLES[status]
  return (
    <NavGroup
      title={t(label)}
      icon={<Icon className={accentClass} />}
      count={count}
      countTone={status === UITaskStatus.Review ? 'warning' : 'neutral'}
      sticky={sticky}
      defaultOpen={defaultOpen}
      className={cn(count > 0 && 'data-[state=open]:mb-4', className)}
    >
      {children}
    </NavGroup>
  )
}
