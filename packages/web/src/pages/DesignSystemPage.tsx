import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { BrandLockup } from '@/components/BrandLogo'
import * as DesignSystem from '@/design-system'
import { Badge, Button, CodeBlock, icons, NavGroup, NavRow, usePrefersReducedMotion } from '@/design-system'
import { SECTION_GROUPS, SECTIONS } from './design-system/sections'
import { ShowcasePart } from './design-system/showcase'
import { CompositionSection, TrendsSection } from './design-system/sections/ChartSections'
import { ActionsSection, StatusSection } from './design-system/sections/FeedbackSections'
import { ColorSection, LayoutSection, PrinciplesSection, TypographySection } from './design-system/sections/FoundationSections'
import { AgentsSection, IconsSection, MotionSection } from './design-system/sections/IdentitySections'
import { InputsSection, OverlaysSection } from './design-system/sections/InputSections'
import { ListsSection, PeopleSection, ScheduleSection, TablesSection } from './design-system/sections/ListSections'
import { GoalsSection, MarksSection, NumbersSection, VizPrinciplesSection } from './design-system/sections/MarkSections'
import { BusinessSection, NavigationSection } from './design-system/sections/NavigationSections'

/** 组件数：设计系统出口里首字母大写的组件（含 Radix 原语的再导出） */
const COMPONENT_COUNT = Object.entries(DesignSystem).filter(([name, value]) => /^[A-Z][a-z]/.test(name) && (typeof value === 'function' || typeof value === 'object')).length
const ICON_COUNT = Object.keys(icons).length

const FACTS = [
  { label: '主色', value: 'Charcoal', note: '#191F25 · 主按钮、选中、图表主系列' },
  { label: '正文', value: '14 / 22', note: '中文最小 12px · 字重 400 / 500 / 600' },
  { label: '行高', value: '32px', note: '侧栏行、默认按钮、工具栏' },
  { label: '圆角', value: '8 · 10 · 14', note: '行 · 浮层与输入框 · 内容岛' },
]

const USAGE = `import { Badge, Button } from '@/design-system'

<Button variant="primary">创建任务</Button>
<Badge tone="warning" variant="dot">待审查</Badge>`

function Hero() {
  return (
    <header className="flex flex-col gap-8 border-b border-border/60 pb-12">
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_420px] xl:items-end">
        <div className="animate-[fadeInUp_0.5s_cubic-bezier(0.16,1,0.3,1)]">
          <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Agent Tower Design System · v1.0</div>
          <h1 className="mt-3 text-[26px] font-medium leading-[34px] tracking-tight text-foreground">设计系统</h1>
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
            从主页提炼的一套界面语言：浅灰外框里放一座白色内容岛，Charcoal 墨色做主角，颜色只留给状态与项目身份。
            这里是全部令牌、组件和展示组件的样张，每张都写了什么时候用、什么时候不用。
          </p>
          <p className="mt-4 text-xs text-muted-foreground">
            <span className="tabular-nums text-foreground/80">{COMPONENT_COUNT}</span> 个组件 ·{' '}
            <span className="tabular-nums text-foreground/80">{ICON_COUNT}</span> 个语义图标 ·{' '}
            <span className="tabular-nums text-foreground/80">{SECTIONS.length}</span> 个章节
          </p>
        </div>
        <CodeBlock title="使用" code={USAGE} />
      </div>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/70 bg-border/60 lg:grid-cols-4">
        {FACTS.map(fact => (
          <div key={fact.label} className="bg-background p-4">
            <dt className="text-xs text-muted-foreground">{fact.label}</dt>
            <dd className="mt-1 text-[17px] font-semibold tracking-tight text-foreground">{fact.value}</dd>
            <dd className="mt-0.5 text-xs text-muted-foreground">{fact.note}</dd>
          </div>
        ))}
      </dl>
    </header>
  )
}

/**
 * 设计系统展示页（/design-system）：沿用主页的灰框白岛骨架——左侧目录是侧栏，右侧内容岛里是全部样张。
 * 目录随滚动高亮当前章节；地址栏的 #章节 可直接分享。
 */
export function DesignSystemPage() {
  const scrollRef = useRef<HTMLElement>(null)
  const [activeId, setActiveId] = useState(SECTIONS[0].id)
  const reducedMotion = usePrefersReducedMotion()

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const visible = new Set<string>()
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id)
          else visible.delete(entry.target.id)
        }
        // 视口上部 35% 的判定带里最靠下的章节即当前章节
        for (let index = SECTIONS.length - 1; index >= 0; index--) {
          if (visible.has(SECTIONS[index].id)) {
            setActiveId(SECTIONS[index].id)
            break
          }
        }
      },
      { root, rootMargin: '0px 0px -65% 0px' },
    )
    root.querySelectorAll<HTMLElement>('[data-ds-section]').forEach(node => observer.observe(node))

    const initial = decodeURIComponent(window.location.hash.slice(1))
    const target = initial ? document.getElementById(initial) : null
    const frame = target ? requestAnimationFrame(() => target.scrollIntoView({ block: 'start' })) : 0

    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  const scrollTo = (id: string) => {
    const node = document.getElementById(id)
    if (!node) return
    node.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
    window.history.replaceState(null, '', `#${id}`)
    setActiveId(id)
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-sidebar text-sm">
      <header className="z-20 flex h-12 shrink-0 items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Link to="/" aria-label="Agent Tower 首页" className="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
            <BrandLockup />
          </Link>
          <span aria-hidden="true" className="select-none text-muted-foreground/40">/</span>
          <span className="truncate font-medium text-foreground/90">设计系统</span>
          <Badge size="sm" variant="outline" className="tabular-nums">v1.0</Badge>
        </div>
        <Button asChild size="sm" variant="ghost">
          <Link to="/"><ArrowLeft />返回工作台</Link>
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="设计系统目录" className="hidden w-60 shrink-0 overflow-y-auto px-2 pb-4 scrollbar-app-thin lg:block">
          {/* 目录只放章节名：编号和组内计数对阅读没有帮助，逐行重复反而成了噪点 */}
          {SECTION_GROUPS.map(group => (
            <NavGroup key={group.title} title={group.title} className="mb-4">
              {group.sections.map(section => (
                <NavRow
                  key={section.id}
                  label={section.title}
                  active={activeId === section.id}
                  aria-current={activeId === section.id ? 'location' : undefined}
                  onClick={() => scrollTo(section.id)}
                />
              ))}
            </NavGroup>
          ))}
        </nav>

        <main
          ref={scrollRef}
          className="relative mb-2 mr-2 min-w-0 flex-1 overflow-y-auto rounded-xl border border-border/50 bg-background scrollbar-app-thin max-lg:ml-2"
        >
          <div className="mx-auto max-w-[1280px] px-6 py-10 sm:px-10">
            <Hero />
            <div className="mt-12 flex flex-col gap-16">
              <ShowcasePart index="I" title="基础" description="颜色、文字、间距、图标与动效：所有组件都从这里取值。" />
              <PrinciplesSection />
              <ColorSection />
              <TypographySection />
              <LayoutSection />
              <IconsSection />
              <AgentsSection />
              <MotionSection />

              <ShowcasePart index="II" title="组件" description="状态、操作、输入、浮层、导航，以及 Agent Tower 专属的业务组件。" />
              <StatusSection />
              <ActionsSection />
              <InputsSection />
              <OverlaysSection />
              <NavigationSection />
              <BusinessSection />

              <ShowcasePart index="III" title="展示组件" description="数字、目标、趋势、构成、清单、表格、排期、人与内容——同一套「实与虚、一种颜色」的画法。" />
              <VizPrinciplesSection />
              <MarksSection />
              <GoalsSection />
              <NumbersSection />
              <TrendsSection />
              <CompositionSection />
              <ListsSection />
              <TablesSection />
              <ScheduleSection />
              <PeopleSection />
            </div>
            <footer className="mt-20 border-t border-border/60 pt-6 text-xs text-muted-foreground">
              组件源码在 <code className="font-mono">packages/web/src/design-system</code>；新增组件先在这里加样张，再进组件库。
            </footer>
          </div>
        </main>
      </div>
    </div>
  )
}
