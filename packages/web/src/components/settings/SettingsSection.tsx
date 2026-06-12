import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * 设置页共享骨架体系 — 视觉规范唯一来源为 .design/DESIGN.md：
 * 排版层级（§3）、四态覆盖（§6）、语义 Token（§8）在此集中落地，
 * 各设置页面只组合这些原语，不再各自手写样式。
 */

export function SettingsPageContainer({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto w-full max-w-4xl px-5 py-5 sm:px-8 sm:py-6', className)}>
      {children}
    </div>
  )
}

/** 页头 — Page Title 层级（20px/600），可挂操作按钮 */
export function SettingsPageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}

/** 区块标题 — Micro 层级（12px/600 大写字距） */
export function SettingsSectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h3 className={cn('text-[12px] font-semibold uppercase tracking-wide text-muted-foreground', className)}>
      {children}
    </h3>
  )
}

/**
 * 设置行 — 左侧标题/说明，右侧控件；可选图标锚点。
 * 行间分隔交由父容器 `divide-y divide-border/60` 控制。
 */
export function SettingsRow({
  label,
  description,
  icon: Icon,
  children,
  align = 'start',
  controlWidth = 'fixed',
  className,
}: {
  label: string
  description?: string
  icon?: LucideIcon
  children: React.ReactNode
  align?: 'start' | 'center'
  /** fixed：右侧控件固定 260px（表单控件对齐）；auto：按内容收缩（如 Switch） */
  controlWidth?: 'fixed' | 'auto'
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 py-5 sm:flex-row sm:justify-between sm:gap-8',
        align === 'center' ? 'sm:items-center' : 'sm:items-start',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3 sm:max-w-[360px]">
        {Icon && (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
            <Icon size={15} />
          </div>
        )}
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-foreground">{label}</div>
          {description && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      <div className={cn('shrink-0', controlWidth === 'fixed' ? 'w-full sm:w-[260px]' : 'w-auto')}>{children}</div>
    </div>
  )
}

interface SettingsFieldProps {
  label: string
  description?: string
  children: React.ReactNode
  className?: string
  htmlFor?: string
}

export function SettingsField({ label, description, children, className, htmlFor }: SettingsFieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div>
        <label htmlFor={htmlFor} className="block text-[13px] font-medium text-foreground">{label}</label>
        {description && (
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </div>
  )
}

/** 空状态 — 48px 浅灰图标 + 一句话说明 + 可选 CTA（§6） */
export function SettingsEmptyState({
  icon: Icon,
  message,
  action,
  className,
}: {
  icon?: LucideIcon
  message: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('rounded-xl border border-dashed border-border bg-muted/30 py-14 text-center', className)}>
      {Icon && <Icon size={48} strokeWidth={1.25} className="mx-auto mb-3 text-muted-foreground/40" aria-hidden="true" />}
      <p className="text-sm text-muted-foreground">{message}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

/** 吸底保存条 — 设置页统一的「未保存更改」交互 */
export function SettingsSaveBar({
  saving,
  onSave,
  onCancel,
  className,
}: {
  saving: boolean
  onSave: () => void
  onCancel?: () => void
  className?: string
}) {
  const { t } = useI18n()
  return (
    <div className={cn('sticky bottom-0 z-10 -mx-5 border-t border-border/60 bg-background/90 px-5 py-3 backdrop-blur sm:-mx-8 sm:px-8', className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{t('有未保存的更改')}</span>
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
              {t('取消')}
            </Button>
          )}
          <Button size="sm" onClick={onSave} disabled={saving}>
            {saving ? t('保存中...') : t('保存')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ── 骨架屏（结构与真实布局一致，§6） ───────────────────────── */

/** 表单页骨架：页头 + 若干设置行 */
export function SettingsFormSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading">
      <Skeleton className="h-7 w-36" />
      <div className="mt-6 divide-y divide-border/60">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-start justify-between gap-8 py-5">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-64 max-w-full" />
            </div>
            <Skeleton className="h-9 w-[260px] shrink-0 rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** 列表-详情页骨架：左侧列表 + 右侧详情面板 */
export function SettingsMasterDetailSkeleton() {
  return (
    <div role="status" aria-label="Loading">
      <Skeleton className="h-7 w-36" />
      <div className="mt-6 grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="space-y-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg px-3 py-2.5">
              <Skeleton className="h-2 w-2 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-2.5 w-1/2" />
              </div>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
          <div className="mt-8 space-y-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  )
}

/** 卡片墙骨架：页头 + 网格卡片 */
export function SettingsCardGridSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div role="status" aria-label="Loading">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-7 w-36" />
        <Skeleton className="h-8 w-44 rounded-lg" />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: cards }).map((_, i) => (
          <div key={i} className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
            <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
