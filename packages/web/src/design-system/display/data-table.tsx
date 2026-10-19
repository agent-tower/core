import { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from '../feedback/skeleton'

export interface DataColumn<T> {
  key: string
  header: ReactNode
  /** 宽度（CSS 值），不传则自适应 */
  width?: string
  align?: 'left' | 'right' | 'center'
  /** 数字列：右对齐 + 等宽数字 */
  numeric?: boolean
  sortable?: boolean
  /** 排序取值；不传则读 row[key] */
  sortValue?: (row: T) => number | string
  render?: (row: T) => ReactNode
}

export interface SortState {
  key: string
  direction: 'asc' | 'desc'
}

export interface DataTableProps<T> {
  columns: DataColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  /** compact 36px 行高（默认，与侧栏密度一致）· comfortable 44px */
  density?: 'compact' | 'comfortable'
  defaultSort?: SortState
  selectedKey?: string | null
  onRowClick?: (row: T) => void
  loading?: boolean
  /** 无数据时的内容，通常是一个小号 EmptyState */
  empty?: ReactNode
  caption?: string
  className?: string
}

function readValue<T>(row: T, column: DataColumn<T>) {
  if (column.sortValue) return column.sortValue(row)
  const value = (row as Record<string, unknown>)[column.key]
  return typeof value === 'number' || typeof value === 'string' ? value : ''
}

/**
 * 数据表：需要逐行比较、排序的结构化数据。表头 11px 灰字、行间 1px 细线、悬停浅灰；
 * 数字列右对齐等宽，状态列用图标 + 文字；可点击行支持 Enter 打开。
 * 刷新时保留旧数据，不要整表闪骨架——骨架只用于首次加载。
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  density = 'compact',
  defaultSort,
  selectedKey,
  onRowClick,
  loading = false,
  empty,
  caption,
  className,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState | null>(defaultSort ?? null)

  const sortedRows = (() => {
    if (!sort) return rows
    const column = columns.find(item => item.key === sort.key)
    if (!column) return rows
    const factor = sort.direction === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const left = readValue(a, column)
      const right = readValue(b, column)
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor
      return String(left).localeCompare(String(right), undefined, { numeric: true }) * factor
    })
  })()

  const toggleSort = (key: string) => {
    setSort(current => {
      if (!current || current.key !== key) return { key, direction: 'desc' }
      if (current.direction === 'desc') return { key, direction: 'asc' }
      return null
    })
  }

  const rowHeight = density === 'compact' ? 'h-9' : 'h-11'
  const alignClass = (column: DataColumn<T>) => (column.numeric || column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : 'text-left')

  return (
    <div className={cn('overflow-x-auto scrollbar-app-thin', className)}>
      <table className="w-full border-collapse text-[13px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-border/70">
            {columns.map(column => {
              const isSorted = sort?.key === column.key
              const SortIcon = !isSorted ? ArrowUpDown : sort?.direction === 'asc' ? ArrowUp : ArrowDown
              return (
                <th
                  key={column.key}
                  scope="col"
                  style={column.width ? { width: column.width } : undefined}
                  aria-sort={isSorted ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cn('h-8 whitespace-nowrap px-3 text-xs font-medium text-muted-foreground first:pl-2 last:pr-2', alignClass(column))}
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className={cn(
                        'group inline-flex items-center gap-1 rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                        (column.numeric || column.align === 'right') && 'flex-row-reverse',
                        isSorted && 'text-foreground',
                      )}
                    >
                      {column.header}
                      <SortIcon aria-hidden="true" className={cn('size-3', isSorted ? 'opacity-100' : 'opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60')} />
                    </button>
                  ) : column.header}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: 4 }).map((_, index) => (
              <tr key={index} className="border-b border-border/40">
                {columns.map(column => (
                  <td key={column.key} className={cn(rowHeight, 'px-3 first:pl-2 last:pr-2')}>
                    <Skeleton className={cn('h-2.5', column.numeric ? 'ml-auto w-10' : 'w-3/4')} />
                  </td>
                ))}
              </tr>
            ))
          ) : sortedRows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="py-2">{empty}</td>
            </tr>
          ) : (
            sortedRows.map(row => {
              const key = rowKey(row)
              const selected = selectedKey === key
              return (
                <tr
                  key={key}
                  aria-selected={onRowClick ? selected : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? event => {
                    if (event.key === 'Enter') onRowClick(row)
                  } : undefined}
                  className={cn(
                    'border-b border-border/40 transition-colors last:border-0',
                    onRowClick && 'cursor-pointer outline-none focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60',
                    selected ? 'bg-accent' : 'hover:bg-accent/60',
                  )}
                >
                  {columns.map(column => (
                    <td
                      key={column.key}
                      className={cn(
                        rowHeight,
                        'px-3 text-foreground/85 first:pl-2 last:pr-2',
                        alignClass(column),
                        column.numeric && 'tabular-nums',
                      )}
                    >
                      {column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? '')}
                    </td>
                  ))}
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
