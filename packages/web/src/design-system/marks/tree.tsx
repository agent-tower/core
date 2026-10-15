import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { formatPercent } from '../lib/format'
import { hasNode } from '../lib/node'
import { Track } from './track'

export interface TreeNode {
  id: string
  label: ReactNode
  /** 标签后的灰色说明：负责人、成员数 */
  meta?: ReactNode
  icon?: ReactNode
  /** 0–1，显示进度条与百分比 */
  progress?: number
  /** 自定义右侧数值，覆盖百分比 */
  value?: ReactNode
  children?: TreeNode[]
}

function collectIds(nodes: TreeNode[], into: Set<string>) {
  for (const node of nodes) {
    if (node.children?.length) {
      into.add(node.id)
      collectIds(node.children, into)
    }
  }
  return into
}

function TreeRows({ nodes, depth, expanded, toggle }: { nodes: TreeNode[]; depth: number; expanded: Set<string>; toggle: (id: string) => void }) {
  const { t } = useI18n()
  return (
    <ul role={depth === 0 ? 'tree' : 'group'} className={cn(depth > 0 && 'ml-[11px]')}>
      {nodes.map(node => {
        const hasChildren = Boolean(node.children?.length)
        const isOpen = expanded.has(node.id)
        return (
          <li
            key={node.id}
            role="treeitem"
            aria-expanded={hasChildren ? isOpen : undefined}
            className={cn(
              'relative',
              depth > 0 && [
                'pl-4',
                // 竖线 + 拐角：每一项自己画到拐角处，最后一项只画半截
                'before:absolute before:left-0 before:top-0 before:h-full before:w-px before:bg-viz-axis last:before:h-3.5',
                'after:absolute after:left-0 after:top-3.5 after:h-px after:w-3 after:bg-viz-axis',
              ],
            )}
          >
            <div className="flex h-7 items-center gap-1.5">
              {hasChildren ? (
                <button
                  type="button"
                  onClick={() => toggle(node.id)}
                  aria-label={isOpen ? t('Collapse') : t('Expand')}
                  className="-ml-0.5 flex size-[18px] shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <ChevronRight aria-hidden="true" className={cn('size-3 transition-transform duration-150', isOpen && 'rotate-90')} />
                </button>
              ) : (
                <span aria-hidden="true" className="flex size-[18px] shrink-0 items-center justify-center">
                  <span className="size-1 rounded-full bg-foreground/30" />
                </span>
              )}
              {node.icon && <span className="flex shrink-0 text-muted-foreground [&_svg]:size-3.5">{node.icon}</span>}
              <span className={cn('min-w-0 truncate text-[13px]', depth === 0 ? 'font-medium text-foreground' : 'text-foreground/85')}>{node.label}</span>
              {hasNode(node.meta) && <span className="shrink-0 truncate text-[11px] text-muted-foreground">{node.meta}</span>}
              <span className="flex-1" />
              {node.progress !== undefined && <Track value={node.progress} size="xs" className="w-14 shrink-0 sm:w-20" />}
              {(node.value !== undefined || node.progress !== undefined) && (
                <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  {node.value ?? formatPercent(node.progress ?? 0)}
                </span>
              )}
            </div>
            {hasChildren && isOpen && node.children && (
              <TreeRows nodes={node.children} depth={depth + 1} expanded={expanded} toggle={toggle} />
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * 树形清单（目标树 / 任务拆解）：父子关系用细线串起，每层缩进 16px；
 * 右侧统一是进度条 + 百分比，层级再深也能纵向对齐比较。默认全部展开。
 */
export function TreeList({ nodes, defaultCollapsed = [], className }: { nodes: TreeNode[]; defaultCollapsed?: string[]; className?: string }) {
  const [expanded, setExpanded] = useState(() => {
    const all = collectIds(nodes, new Set<string>())
    defaultCollapsed.forEach(id => all.delete(id))
    return all
  })

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className={className}>
      <TreeRows nodes={nodes} depth={0} expanded={expanded} toggle={toggle} />
    </div>
  )
}
