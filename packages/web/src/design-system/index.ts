/**
 * Agent Tower 设计系统 — 统一出口。
 *
 * 业务代码只从这里引入：`import { Button, Badge, LineChart } from '@/design-system'`。
 * 目录按职责分层（由底向上依赖，不允许反向引用）：
 *   tokens / lib  →  icons / feedback / actions / inputs / overlays / navigation
 *   →  marks  →  charts / display  →  domain（唯一可以依赖业务类型的一层）
 */

/* 基础 */
export * from './tokens'
export * from './lib/scale'
export * from './lib/format'
export { addDays } from './lib/date'
export { hasNode } from './lib/node'
export { useControllableState, useElementWidth, usePrefersReducedMotion, useSvgId } from './lib/hooks'
export { useNow, formatRelativeTime } from './lib/clock'

/* 图标 */
export { Icon, type IconProps } from './icons/icon'
export { icons, ICON_SIZE, ICON_GROUPS, type IconName, type IconSize } from './icons/registry'

/* 状态反馈 */
export { Spinner, type SpinnerProps } from './feedback/spinner'
export { Badge, CountBadge, type BadgeProps, type BadgeVariant, type CountBadgeProps } from './feedback/badge'
export { Notice, type NoticeProps } from './feedback/notice'
export { EmptyState, type EmptyStateProps } from './feedback/empty-state'
export { Skeleton, SkeletonText, SkeletonRows } from './feedback/skeleton'
export { LiveDot, ThinkingText, WorkingDots, type LiveDotProps } from './feedback/live'

/* 操作 */
export { buttonClassName, type ButtonVariant, type ButtonTone, type ButtonSize, type ButtonStyleOptions } from './actions/button-styles'
export { Button, type ButtonProps } from './actions/button'
export { IconButton, type IconButtonProps } from './actions/icon-button'
export { CopyButton, type CopyButtonProps } from './actions/copy-button'
export { Kbd, KbdGroup, type KbdProps, type KbdGroupProps } from './actions/kbd'

/* 输入 */
export { Field, type FieldProps } from './inputs/field'
export { useFieldControl, type FieldControlContext } from './inputs/field-context'
export { Input, type InputProps } from './inputs/input'
export { Textarea, type TextareaProps } from './inputs/textarea'
export { SearchField, type SearchFieldProps } from './inputs/search-field'
export { Select, type SelectProps, type SelectOption } from './inputs/select'
export { Slider, type SliderProps } from './inputs/slider'
export { Segmented, type SegmentedProps, type SegmentedOption } from './inputs/segmented'
export { Tabs, TabsList, TabsTrigger, TabsContent } from './inputs/tabs'
export { Chip, Tag, type ChipProps, type TagProps } from './inputs/chip'
export { ChipSelect, type ChipSelectProps, type ChipSelectOption } from './inputs/chip-select'
export { Switch, Checkbox, RadioGroup, type SwitchProps, type CheckboxProps, type RadioGroupProps, type RadioOption } from './inputs/toggles'
export { Composer, type ComposerProps } from './inputs/composer'

/* 浮层 */
export {
  MENU_SURFACE,
  MENU_ITEM,
  MENU_ITEM_CHECKABLE,
  MENU_ITEM_DANGER,
  MENU_INDICATOR,
  MENU_LABEL,
  MENU_SEPARATOR,
  MENU_SHORTCUT,
} from './overlays/menu-styles'
export {
  Menu,
  MenuTrigger,
  MenuGroup,
  MenuRadioGroup,
  MenuSub,
  MenuContent,
  MenuItem,
  MenuCheckboxItem,
  MenuRadioItem,
  MenuLabel,
  MenuSeparator,
  MenuSubTrigger,
  MenuSubContent,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  type MenuItemProps,
} from './overlays/menu'
export { Tooltip, type TooltipProps } from './overlays/tooltip'
export { Popover, PopoverTrigger, PopoverClose, PopoverAnchor, PopoverContent } from './overlays/popover'
export { Dialog, DialogTrigger, DialogClose, DialogContent, ConfirmDialog, type DialogContentProps, type ConfirmDialogProps } from './overlays/dialog'

/* 导航 */
export { navRowClassName } from './navigation/nav-row-styles'
export { NavRow, NavRowLink, type NavRowProps, type NavRowLinkProps } from './navigation/nav-row'
export { NavGroup, type NavGroupProps } from './navigation/nav-group'
export { Breadcrumb, BreadcrumbItem, type BreadcrumbItemProps } from './navigation/breadcrumb'
export { Stepper, StepList, type StepStatus, type StepperStep, type StepperProps, type StepListItem } from './navigation/steps'

/* 画法（图表的最小单元） */
export { Legend, LegendSwatchMark, type LegendItem, type LegendSwatch } from './marks/legend'
export { Delta, type DeltaProps } from './marks/delta'
export { Track, type TrackProps, type TrackTone } from './marks/track'
export { Ring, type RingProps } from './marks/ring'
export { Sparkline, type SparklineProps } from './marks/sparkline'
export { StateSquare, HealthBadge, type StateSquareProps, type SquareState, type Health } from './marks/state'
export { TreeList, type TreeNode } from './marks/tree'

/* 图表 */
export { SERIES_COLOR, stackColors, type SeriesVariant } from './charts/chart-utils'
export { ChartFrame, type ChartFrameProps, type ChartTableColumn, type ChartTableData } from './charts/chart-frame'
export { ChartTooltip, type ChartTooltipProps, type ChartTooltipRow } from './charts/chart-parts'
export { LineChart, type LineChartProps, type LineSeries } from './charts/line-chart'
export { BarChart, StackedBarChart, type BarChartProps, type BarSeries, type StackedBarChartProps } from './charts/bar-chart'
export { SlopeChart, type SlopeChartProps, type SlopeItem } from './charts/slope-chart'
export {
  DonutChart,
  WaffleChart,
  RankedBars,
  FunnelChart,
  type DonutChartProps,
  type DonutSegment,
  type WaffleChartProps,
  type RankedBarsProps,
  type RankedItem,
  type FunnelChartProps,
  type FunnelStage,
} from './charts/part-to-whole'
export { HeatTable, CalendarHeatmap, ScaleLegend, type HeatTableProps, type HeatTableRow, type CalendarHeatmapProps } from './charts/heatmaps'
export { ScatterChart, type ScatterChartProps, type ScatterPoint } from './charts/scatter-chart'
export { GanttChart, MonthCalendar, type GanttChartProps, type GanttTask, type MonthCalendarProps, type CalendarEvent } from './charts/schedule'

/* 展示 */
export { Panel, type PanelProps } from './display/panel'
export { StatTile, StatGroup, HeroFigure, Meter, type StatTileProps, type HeroFigureProps, type MeterProps } from './display/stat'
export { ObjectiveCard, type ObjectiveCardProps, type KeyResult } from './display/objective'
export {
  TodoList,
  Timeline,
  ActivityFeed,
  DeadlineList,
  Leaderboard,
  Bulletin,
  type TodoItem,
  type TodoListProps,
  type TodoState,
  type TimelineEntry,
  type TimelineGroup,
  type ActivityEntry,
  type DeadlineItem,
  type LeaderEntry,
  type BulletinItem,
} from './display/lists'
export { DataTable, type DataColumn, type DataTableProps, type SortState } from './display/data-table'
export { ProcessSteps, TopologyTree, type ProcessStatus, type ProcessStep, type TopologyNode } from './display/process'
export { Avatar, AvatarGroup, MessageBubble, type AvatarProps, type AvatarSize, type AvatarGroupProps, type MessageBubbleProps } from './display/people'
export {
  FileRow,
  FileChip,
  CommitItem,
  CodeBlock,
  TerminalBlock,
  PromptBlock,
  type FileChangeStatus,
  type FileRowProps,
  type CommitItemProps,
  type CodeBlockProps,
  type TerminalLine,
} from './display/content'

/* 业务组件（Agent Tower 专属） */
export { shortenProjectName, projectDotClass } from './domain/format'
export { ProjectDot, ProjectTag, AgentMark, BranchTag, DiffStat, type ProjectTagProps, type AgentMarkProps, type DiffStatProps } from './domain/tags'
export { TaskStatusIcon, TaskStatusBadge, PriorityTag, TaskRow, TaskStatusGroup, type TaskRowProps, type TaskStatusGroupProps } from './domain/task'
export { RelativeTime, type RelativeTimeProps } from './domain/time'
