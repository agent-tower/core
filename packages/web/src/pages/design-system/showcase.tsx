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
    <section id={id} data-ds-section="" aria-labelledby={`${id}-title`} className="scroll-mt-8 [counter-reset:ds-specimen]">
      <header className="mb-6">
        <div className="flex items-center gap-2 font-mono text-[11px] tracking-wide text-muted-foreground">
          <span className="tabular-nums text-foreground/80">{number}</span>
          <span aria-hidden="true" className="h-px w-5 bg-border" />
          <span className="uppercase">{meta?.en}</span>
        </div>
        <h2 id={`${id}-title`} className="mt-2.5 text-[22px] font-semibold leading-[30px] tracking-tight text-foreground">
          {meta?.title ?? id}
        </h2>
        {description && <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>}
      </header>
      <SectionNumberContext.Provider value={number}>
        <div
          className={cn(
            'grid grid-cols-1 gap-5',
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
  /** 组件名（等宽），即代码里的名字；跟在中文名后面作注，没有中文名时直接作标题 */
  name: string
  /** 中文名：样张标题 */
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
      {/* 标题区不画分隔线：靠字号和留白和示例分开，卡片里只剩「示例 | 用法」一条线 */}
      <header className={cn('px-6 pt-5', canvas === 'chrome' ? 'pb-5' : 'pb-1')}>
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">{title ?? name}</h3>
          {title && <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{name}</span>}
          <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] tabular-nums text-muted-foreground/50">
            {number}.<span className="before:content-[counter(ds-specimen)]" />
          </span>
        </div>
        {description && <p className="mt-1.5 max-w-3xl text-[13px] leading-[22px] text-muted-foreground">{description}</p>}
      </header>
      <div className={cn('min-w-0 flex-1 px-6 pb-6', canvas === 'chrome' ? 'bg-sidebar pt-6' : 'pt-5', bodyClassName)}>{children}</div>
      {hasRules && (
        <footer className="grid gap-x-8 gap-y-2.5 border-t border-border/50 px-6 py-4 sm:grid-cols-2">
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
    <ul className="flex flex-col gap-1.5" aria-label={kind === 'do' ? '推荐' : '避免'}>
      {rules.map((rule, index) => (
        <li key={index} className="flex gap-2 text-xs leading-5 text-muted-foreground">
          {/* 规则是读物不是警报：对勾和叉只用浅一档的状态色 */}
          <Glyph aria-hidden="true" className={cn('mt-1 size-3 shrink-0', kind === 'do' ? 'text-success/80' : 'text-destructive/70')} strokeWidth={2.5} />
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
      {label !== undefined && <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

/** 示例下方的说明 */
export function Caption({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn('text-xs leading-5 text-muted-foreground', className)}>{children}</p>
}

/** 等宽的 token / 类名 */
export function Code({ className, children }: { className?: string; children: ReactNode }) {
  return <code className={cn('rounded bg-foreground/[0.05] px-1 py-px font-mono text-[11px] text-foreground/80', className)}>{children}</code>
}
