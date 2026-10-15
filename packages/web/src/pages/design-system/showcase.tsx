import { createContext, useContext, type ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SECTIONS, sectionNumber } from './sections'

/**
 * 展示页骨架：章节 → 样张（Specimen）→ 用法规则。
 * 样张编号由 CSS 计数器生成（章节号.序号），增删样张不用手动改号。
 */

const SectionNumberContext = createContext('')

export interface ShowcaseSectionProps {
  id: string
  description?: ReactNode
  /** 样张栅格：2 列（默认，xl 起）· 3 列 · 1 列 */
  columns?: 1 | 2 | 3
  children: ReactNode
}

export function ShowcaseSection({ id, description, columns = 2, children }: ShowcaseSectionProps) {
  const meta = SECTIONS.find(section => section.id === id)
  const number = sectionNumber(id)
  return (
    <section id={id} data-ds-section="" aria-labelledby={`${id}-title`} className="scroll-mt-6 [counter-reset:ds-specimen]">
      <header className="mb-5">
        <div className="flex items-center gap-2 font-mono text-[11px] tracking-wide text-muted-foreground">
          <span className="tabular-nums text-foreground">{number}</span>
          <span aria-hidden="true" className="h-px w-5 bg-border" />
          <span className="uppercase">{meta?.en}</span>
        </div>
        <h2 id={`${id}-title`} className="mt-2 text-[22px] font-semibold leading-tight tracking-tight text-foreground">
          {meta?.title ?? id}
        </h2>
        {description && <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
      </header>
      <SectionNumberContext.Provider value={number}>
        <div
          className={cn(
            'grid grid-cols-1 gap-4',
            columns === 2 && 'xl:grid-cols-2',
            columns === 3 && 'lg:grid-cols-2 2xl:grid-cols-3',
          )}
        >
          {children}
        </div>
      </SectionNumberContext.Provider>
    </section>
  )
}

/** 部分分隔：基础 / 组件 / 展示组件 */
export function ShowcasePart({ index, title, description }: { index: string; title: string; description?: ReactNode }) {
  return (
    <div className="pt-4">
      <div className="flex items-center gap-3 text-[11px] font-medium text-muted-foreground">
        <span className="font-mono tracking-wide">PART {index}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
      </div>
      <p className="mt-3 text-[26px] font-medium leading-snug tracking-tight text-foreground">{title}</p>
      {description && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
    </div>
  )
}

export interface SpecimenProps {
  /** 组件名（等宽），即代码里的名字 */
  name: string
  /** 中文名 */
  title?: ReactNode
  /** 一句话：什么时候用 */
  description?: ReactNode
  /** 跨列（栅格为 2 / 3 列时） */
  span?: 1 | 2 | 3
  /** 推荐做法 */
  dos?: ReactNode[]
  /** 避免的做法 */
  donts?: ReactNode[]
  /** chrome：浅灰画布，白卡、侧栏行、浮层这类「白在灰上」的组件放在这里才看得出边界 */
  canvas?: 'plain' | 'chrome'
  bodyClassName?: string
  className?: string
  children: ReactNode
}

export function Specimen({ name, title, description, span = 1, dos, donts, canvas = 'plain', bodyClassName, className, children }: SpecimenProps) {
  const number = useContext(SectionNumberContext)
  const hasRules = Boolean(dos?.length || donts?.length)
  return (
    <article
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-background [counter-increment:ds-specimen]',
        span === 2 && 'xl:col-span-2',
        span === 3 && 'lg:col-span-2 2xl:col-span-3',
        className,
      )}
    >
      <header className="border-b border-border/50 px-4 py-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60">
            {number}.<span className="before:content-[counter(ds-specimen)]" />
          </span>
          <h3 className="shrink-0 font-mono text-xs font-medium text-foreground">{name}</h3>
          {title && <span className="min-w-0 truncate text-xs text-muted-foreground">{title}</span>}
        </div>
        {description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </header>
      <div className={cn('min-w-0 flex-1 p-5', canvas === 'chrome' && 'bg-sidebar', bodyClassName)}>{children}</div>
      {hasRules && (
        <footer className="grid gap-x-6 gap-y-2 border-t border-border/50 bg-foreground/[0.015] px-4 py-3 sm:grid-cols-2">
          {dos?.length ? <RuleList kind="do" rules={dos} /> : null}
          {donts?.length ? <RuleList kind="dont" rules={donts} /> : null}
        </footer>
      )}
    </article>
  )
}

function RuleList({ kind, rules }: { kind: 'do' | 'dont'; rules: ReactNode[] }) {
  const Glyph = kind === 'do' ? Check : X
  return (
    <ul className="flex flex-col gap-1" aria-label={kind === 'do' ? '推荐' : '避免'}>
      {rules.map((rule, index) => (
        <li key={index} className="flex gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <Glyph aria-hidden="true" className={cn('mt-[3px] size-3 shrink-0', kind === 'do' ? 'text-success' : 'text-destructive')} strokeWidth={2.5} />
          <span>{rule}</span>
        </li>
      ))}
    </ul>
  )
}

/** 样张内的一行：左侧小标签 + 右侧示例 */
export function DemoRow({ label, className, children }: { label?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4', className)}>
      {label !== undefined && <span className="w-20 shrink-0 text-[11px] text-muted-foreground">{label}</span>}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

/** 示例下方的说明 */
export function Caption({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn('text-[11px] leading-relaxed text-muted-foreground', className)}>{children}</p>
}

/** 等宽的 token / 类名 */
export function Code({ className, children }: { className?: string; children: ReactNode }) {
  return <code className={cn('rounded bg-foreground/[0.05] px-1 py-px font-mono text-[11px] text-foreground/80', className)}>{children}</code>
}
