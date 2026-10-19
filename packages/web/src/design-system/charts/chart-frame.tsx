import { useId, useState, type ReactNode } from 'react'
import { ChartColumn, Table2 } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { IconButton } from '../actions/icon-button'

export interface ChartTableColumn {
  key: string
  header: ReactNode
  align?: 'left' | 'right'
}

export interface ChartTableData {
  columns: ChartTableColumn[]
  rows: Record<string, ReactNode>[]
}

export interface ChartFrameProps {
  title: ReactNode
  subtitle?: ReactNode
  /** 两个及以上系列时放 Legend */
  legend?: ReactNode
  actions?: ReactNode
  /** 表格视图：图表的无障碍孪生，提供后右上角出现切换按钮 */
  table?: ChartTableData
  footnote?: ReactNode
  /** 去掉卡片外壳，嵌入已有面板时使用 */
  bare?: boolean
  className?: string
  children: ReactNode
}

/**
 * 图表外壳：标题（说清楚画的是什么）· 副标题（单位 / 口径）· 图例 · 图表 / 表格切换 · 脚注。
 * 每张图都应该能切到表格——提示浮层只是增强，数值必须不靠悬停也能读到。
 */
export function ChartFrame({ title, subtitle, legend, actions, table, footnote, bare = false, className, children }: ChartFrameProps) {
  const { t } = useI18n()
  const titleId = useId()
  const [view, setView] = useState<'chart' | 'table'>('chart')

  return (
    <figure
      aria-labelledby={titleId}
      className={cn('flex min-w-0 flex-col', !bare && 'rounded-xl border border-border/70 bg-background p-4', className)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div id={titleId} className="text-[13px] font-semibold leading-5 text-foreground">{title}</div>
          {subtitle && <div className="mt-0.5 text-xs leading-[18px] text-muted-foreground">{subtitle}</div>}
        </div>
        {(actions || table) && (
          <div className="-mr-1 -mt-0.5 flex shrink-0 items-center gap-1">
            {actions}
            {table && (
              <IconButton
                size="xs"
                label={view === 'chart' ? t('Table') : t('Chart')}
                aria-pressed={view === 'table'}
                onClick={() => setView(current => (current === 'chart' ? 'table' : 'chart'))}
              >
                {view === 'chart' ? <Table2 /> : <ChartColumn />}
              </IconButton>
            )}
          </div>
        )}
      </div>
      {legend && view === 'chart' && <div className="mt-2">{legend}</div>}
      <div className="mt-3 min-w-0">
        {view === 'table' && table ? <ChartTable data={table} /> : children}
      </div>
      {footnote && <figcaption className="mt-3 text-xs leading-5 text-muted-foreground">{footnote}</figcaption>}
    </figure>
  )
}

function ChartTable({ data }: { data: ChartTableData }) {
  return (
    <div className="max-h-72 overflow-auto scrollbar-app-thin">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-background">
          <tr className="border-b border-border/60">
            {data.columns.map(column => (
              <th
                key={column.key}
                scope="col"
                className={cn('h-7 px-2 font-medium text-muted-foreground first:pl-0 last:pr-0', column.align === 'right' ? 'text-right' : 'text-left')}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, index) => (
            <tr key={index} className="border-b border-border/40 last:border-0">
              {data.columns.map(column => (
                <td
                  key={column.key}
                  className={cn('h-7 px-2 text-foreground/85 first:pl-0 last:pr-0', column.align === 'right' ? 'text-right tabular-nums' : 'text-left')}
                >
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
