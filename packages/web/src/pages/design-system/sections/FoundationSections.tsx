import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info, MousePointer2, Plus, TriangleAlert, type LucideIcon } from 'lucide-react'
import {
  Badge,
  Button,
  Legend,
  ProjectDot,
  ProjectTag,
  TONE_DOT,
  TONE_INK,
  TONE_MARK,
  VIZ,
  VIZ_RAMP,
  type ButtonSize,
  type Tone,
} from '@/design-system'
import { cn } from '@/lib/utils'
import { DEMO_PROJECTS, PROJECT_COLORS } from '../demo-data'
import { Caption, Code, ShowcaseSection, Specimen } from '../showcase'

/* ── 原则 ─────────────────────────────────────────────────── */

function PrincipleCard({ title, art, children }: { title: string; art: ReactNode; children: ReactNode }) {
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-background">
      <div aria-hidden="true" className="flex h-36 items-center justify-center border-b border-border/50 bg-foreground/[0.015] px-6">
        {art}
      </div>
      <div className="px-5 pb-5 pt-4">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="mt-1.5 text-[13px] leading-[22px] text-muted-foreground">{children}</p>
      </div>
    </article>
  )
}

function MiniRow({ title, meta = false, active = false, hovered = false, status }: { title: string; meta?: boolean; active?: boolean; hovered?: boolean; status?: ReactNode }) {
  return (
    <div
      className={cn(
        'flex h-6 items-center gap-1.5 rounded-[5px] px-1.5',
        active && 'bg-background shadow-raised ring-1 ring-border/80',
        hovered && 'bg-accent',
      )}
    >
      {status ?? <span className="size-2 shrink-0 rounded-full ring-[1.5px] ring-inset ring-foreground/30" />}
      <span className={cn('h-1.5 rounded-full', active ? 'bg-foreground/80' : 'bg-foreground/45', title)} />
      {meta && (
        <span className="ml-auto flex items-center gap-1">
          <span className="h-2.5 w-7 rounded-[3px] bg-foreground/[0.07]" />
          <span className="h-1.5 w-3.5 rounded-full bg-foreground/20" />
        </span>
      )}
      {hovered && <MousePointer2 className="ml-auto size-3 text-foreground/60" />}
    </div>
  )
}

export function PrinciplesSection() {
  return (
    <ShowcaseSection
      id="principles"
      columns={3}
      description="全部规则都从现有主页长出来：浅灰外框里放一座白色内容岛，Charcoal 墨色做主角，颜色只留给状态与项目身份。遇到规范没覆盖的情况，按这六条推理。"
    >
      <PrincipleCard
        title="灰框白岛"
        art={(
          <div className="flex h-24 w-full max-w-[220px] flex-col rounded-lg bg-sidebar ring-1 ring-border">
            <div className="flex h-4 shrink-0 items-center gap-1 px-2">
              <span className="h-1.5 w-6 rounded-full bg-foreground/80" />
              <span className="h-1 w-8 rounded-full bg-foreground/15" />
            </div>
            <div className="flex min-h-0 flex-1 gap-1.5 px-1.5 pb-1.5">
              <div className="flex w-14 flex-col gap-1 pt-1">
                <span className="h-2 rounded-[3px] bg-foreground/10" />
                <span className="h-2.5 rounded-[3px] bg-background shadow-raised ring-1 ring-border/80" />
                <span className="h-2 rounded-[3px] bg-foreground/10" />
                <span className="h-2 rounded-[3px] bg-foreground/10" />
              </div>
              <div className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-md border border-border/60 bg-background">
                <span className="h-1.5 w-16 rounded-full bg-foreground/70" />
                <span className="h-5 w-20 rounded-[4px] ring-1 ring-border" />
              </div>
            </div>
          </div>
        )}
      >
        界面分两层：浅灰外框（顶栏、侧栏）承载导航，白色内容岛承载正在处理的对象。层级靠底色和 1px 细边区分，不靠阴影堆叠。
      </PrincipleCard>

      <PrincipleCard
        title="标题优先"
        art={(
          <div className="w-full max-w-[240px] space-y-0.5 rounded-lg bg-sidebar p-1.5 ring-1 ring-border/70">
            <MiniRow title="w-[44%]" meta />
            <MiniRow title="w-[72%]" hovered />
            <MiniRow title="w-[36%]" meta />
          </div>
        )}
      >
        列表行里标题拥有最大宽度。元信息（项目、时间）必须紧凑，悬停或键盘聚焦时整体让位；宁可截短元信息，也不截短标题。
      </PrincipleCard>

      <PrincipleCard
        title="墨色为主"
        art={(
          <div className="flex items-end gap-4">
            <span className="flex h-7 items-center rounded-md bg-primary px-3 text-[11px] font-medium text-primary-foreground shadow-raised">开始</span>
            <span className="relative mb-1.5 h-4 w-7 rounded-full bg-primary">
              <span className="absolute right-0.5 top-0.5 size-3 rounded-full bg-background" />
            </span>
            <span className="flex h-12 items-end gap-1">
              {[0.45, 0.7, 0.55, 1].map((height, index) => (
                <span key={index} className="w-2.5 rounded-t-[2px] bg-viz-6" style={{ height: `${height * 100}%` }} />
              ))}
            </span>
          </div>
        )}
      >
        Charcoal 是唯一的主色：主按钮、选中、开关、图表主系列都用它。蓝色只表示「运行中 / 信息」，不再作品牌色。
      </PrincipleCard>

      <PrincipleCard
        title="颜色只给状态"
        art={(
          <div className="w-full max-w-[220px] space-y-0.5 rounded-lg bg-background p-1.5 ring-1 ring-border/70">
            <MiniRow title="w-[50%]" />
            <MiniRow
              title="w-[40%]"
              status={<TriangleAlert className="size-2.5 shrink-0 text-warning" strokeWidth={2.5} />}
            />
            <MiniRow title="w-[58%]" />
            <div className="flex justify-end px-1.5 pt-0.5">
              <span className="rounded-full bg-warning/10 px-1.5 py-px text-[10px] font-medium text-warning-ink">待审查 1</span>
            </div>
          </div>
        )}
      >
        颜色是稀缺资源，只表达需要注意的状态（运行中、待审查、失败）和项目身份。没有状态含义的东西一律用灰阶，状态也永远配图标或文字。
      </PrincipleCard>

      <PrincipleCard
        title="浮起 = 正在打开"
        art={(
          <div className="flex w-full max-w-[220px] flex-col gap-2 rounded-lg bg-sidebar p-2 ring-1 ring-border/70">
            <div className="inline-flex gap-0.5 self-start rounded-md bg-foreground/[0.05] p-0.5">
              <span className="rounded-[5px] bg-background px-2 py-0.5 text-[10px] font-medium text-foreground shadow-raised ring-1 ring-border/80">列表</span>
              <span className="px-2 py-0.5 text-[10px] text-foreground/60">看板</span>
            </div>
            <div className="space-y-0.5">
              <MiniRow title="w-[46%]" />
              <MiniRow title="w-[60%]" active />
              <MiniRow title="w-[38%]" />
            </div>
          </div>
        )}
      >
        白卡浮在灰底上，表示「这一项正在右侧展示」：侧栏选中行、分段控件的选中段是同一种材质，只表达这一个意思。
      </PrincipleCard>

      <PrincipleCard
        title="动效只解释变化"
        art={(
          <div className="relative h-20 w-44">
            <span className="absolute inset-x-6 top-7 h-10 rounded-lg bg-background opacity-30 ring-1 ring-border/60" />
            <span className="absolute inset-x-3 top-3.5 h-10 rounded-lg bg-background opacity-60 ring-1 ring-border/70" />
            <span className="absolute inset-x-0 top-0 flex h-10 items-center gap-2 rounded-lg bg-background px-3 shadow-raised ring-1 ring-border/80">
              <span className="size-2 rounded-full bg-info" />
              <span className="h-1.5 w-16 rounded-full bg-foreground/60" />
            </span>
            <span className="absolute inset-x-0 bottom-0 text-center font-mono text-[11px] text-muted-foreground">250ms · ease-enter</span>
          </div>
        )}
      >
        动效说明「什么变了」：新内容上浮淡入，状态切换 150ms 完成，不做装饰性循环。开启「减少动态效果」时只保留必要的进行中提示。
      </PrincipleCard>
    </ShowcaseSection>
  )
}

/* ── 颜色 ─────────────────────────────────────────────────── */

interface SwatchSpec {
  name: string
  token: string
  hex: string
  value: string
  usage: string
}

const SURFACES: SwatchSpec[] = [
  { name: '外框', token: '--sidebar', hex: '#F9FAFB', value: 'var(--sidebar)', usage: '顶栏、侧栏、页面底色' },
  { name: '内容岛', token: '--background', hex: '#FFFFFF', value: 'var(--background)', usage: '内容岛、卡片、输入框、菜单' },
  { name: '悬停', token: '--accent', hex: '#F3F4F6', value: 'var(--accent)', usage: '行悬停、ghost 按钮' },
  { name: '浅灰底', token: 'foreground / 5%', hex: '≈ #F4F4F4', value: 'color-mix(in oklab, var(--foreground) 5%, var(--background))', usage: '分段轨道、标签、代码、头像' },
  { name: '反色', token: '--inverse', hex: '#191F25', value: 'var(--inverse)', usage: 'Tooltip、Toast 等浮在内容上的小面' },
  { name: '终端', token: '--terminal', hex: '#1E1E1E', value: 'var(--terminal)', usage: '终端与日志：唯一常驻深色面' },
]

function Swatch({ name, token, hex, value, usage }: SwatchSpec) {
  return (
    <div className="min-w-0">
      <div className="h-14 rounded-lg ring-1 ring-inset ring-black/[0.07]" style={{ background: value }} />
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{name}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{hex}</span>
      </div>
      <div className="truncate font-mono text-[11px] text-muted-foreground">{token}</div>
      <p className="mt-1 text-xs leading-[18px] text-muted-foreground">{usage}</p>
    </div>
  )
}

const INKS = [
  { name: '正文', className: 'text-foreground', token: 'foreground', ratio: 16.5, usage: '标题、正文、选中项' },
  { name: '次要正文', className: 'text-foreground/80', token: 'foreground / 80%', ratio: 8.6, usage: '列表行、菜单项、未选中的值' },
  { name: '弱正文', className: 'text-foreground/70', token: 'foreground / 70%', ratio: 6.1, usage: '浅灰底上的标签文字（neutral ink）' },
  { name: '说明', className: 'text-muted-foreground', token: 'muted-foreground', ratio: 4.85, usage: '元信息、时间、计数、表头：白底上最浅的可读文字' },
  { name: '占位', className: 'text-muted-foreground/70', token: 'muted-foreground / 70%', ratio: 2.75, usage: '只用于占位符与禁用态，不承载信息' },
]

const STATUS_ROWS: { tone: Exclude<Tone, 'neutral'>; name: string; meaning: string; icon: LucideIcon; base: string; ink: string; baseRatio: number; inkRatio: number }[] = [
  { tone: 'info', name: '信息', meaning: '运行中、提示', icon: Info, base: '--info', ink: '--info-ink', baseRatio: 5.17, inkRatio: 6.31 },
  { tone: 'success', name: '成功', meaning: '已完成、已合并、在线', icon: CircleCheck, base: '--success', ink: '--success-ink', baseRatio: 3.3, inkRatio: 5.64 },
  { tone: 'warning', name: '警告', meaning: '待审查、临近截止、需要确认', icon: TriangleAlert, base: '--warning', ink: '--warning-ink', baseRatio: 3.18, inkRatio: 5.78 },
  { tone: 'danger', name: '危险', meaning: '失败、逾期、删除', icon: CircleAlert, base: '--destructive', ink: '--destructive-ink', baseRatio: 4.83, inkRatio: 6.38 },
]

/** 终端上的界面层；预览都画在终端底色上 */
const TERMINAL_TOKENS: { token: string; preview: ReactNode; usage: string }[] = [
  { token: '--terminal', preview: <span className="size-full bg-terminal" />, usage: '终端正文和日志；选中的标签、行也用它' },
  { token: '--terminal-chrome', preview: <span className="size-full bg-terminal-chrome" />, usage: '标签栏、标题栏、侧列表' },
  {
    token: '--terminal-accent',
    preview: <span className="size-full bg-terminal-chrome"><span className="block size-full bg-terminal-accent" /></span>,
    usage: '悬停：6% 白，叠在哪一层上都成立',
  },
  { token: '--terminal-border', preview: <span className="size-full p-1.5"><span className="block size-full rounded border border-terminal-border" /></span>, usage: '分隔线、描边：8% 白' },
  { token: '--terminal-foreground', preview: <span className="text-xs font-medium text-terminal-foreground">Aa</span>, usage: '正文、选中项的文字' },
  { token: '--terminal-muted-foreground', preview: <span className="text-xs font-medium text-terminal-muted-foreground">Aa</span>, usage: '标签、表头、次要信息（标签栏悬停态上仍 ≥ 4.5:1）' },
]

/** 程序输出的 ANSI 色，与 xterm 是同一套 */
const TERMINAL_ANSI = [
  { name: 'red', className: 'bg-terminal-red', usage: '失败' },
  { name: 'green', className: 'bg-terminal-green', usage: '成功' },
  { name: 'yellow', className: 'bg-terminal-yellow', usage: '警告' },
  { name: 'blue', className: 'bg-terminal-blue', usage: '运行中' },
  { name: 'magenta', className: 'bg-terminal-magenta', usage: '程序输出' },
  { name: 'cyan', className: 'bg-terminal-cyan', usage: '程序输出' },
  { name: 'bright-black', className: 'bg-terminal-bright-black', usage: '提示符' },
]

function TerminalTab({ state, dot, children }: { state: 'selected' | 'hover' | 'idle'; dot: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'flex h-8 items-center gap-2 rounded-t-md px-3 font-mono text-xs',
        state === 'selected' && 'bg-terminal text-terminal-foreground',
        state === 'hover' && 'bg-terminal-accent text-terminal-muted-foreground',
        state === 'idle' && 'text-terminal-muted-foreground',
      )}
    >
      <span className={cn('size-1.5 rounded-full', dot)} />
      {children}
    </span>
  )
}

const RAMP_INFO = [
  { hex: '#EFF0F3', ratio: '1.14', usage: '零值 / 空格' },
  { hex: '#CED1D6', ratio: '1.53', usage: '量级 1' },
  { hex: '#A0A5AC', ratio: '2.48', usage: '对比 · 序数起点' },
  { hex: '#7B8189', ratio: '3.94', usage: '计划斜纹' },
  { hex: '#555B63', ratio: '6.82', usage: '量级 4' },
  { hex: '#333940', ratio: '11.7', usage: '量级 5' },
  { hex: '#191F25', ratio: '16.7', usage: '主数据' },
]

export function ColorSection() {
  return (
    <ShowcaseSection
      id="color"
      description="中性色全部带一点冷蓝（色相 255–264），与 Charcoal 主色同源。所有颜色都是 CSS 变量（src/index.css），组件里只写语义类名，不写色值。"
    >
      <Specimen name="Surface" title="表面" description="从外到内：外框 → 内容岛 → 悬停 / 浅灰底。深色只出现在反色小面和终端。" span={2}>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {SURFACES.map(surface => <Swatch key={surface.name} {...surface} />)}
        </div>
      </Specimen>

      <Specimen
        name="Ink"
        title="文字墨阶"
        description="文字只有这几档；对比度按白底计算。"
        dos={['正文类文字至少 4.5:1；muted-foreground 是白底上最浅的可读文字']}
        donts={['用透明度再调浅说明文字（muted/80 只有 3.3:1）']}
      >
        <div className="flex flex-col divide-y divide-border/50">
          {INKS.map(ink => (
            <div key={ink.token} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
              <span className={cn('w-28 shrink-0 text-sm', ink.className)}>任务看板 Aa 128</span>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-foreground">{ink.name} <Code className="ml-1">{ink.token}</Code></div>
                <div className="text-xs leading-[18px] text-muted-foreground">{ink.usage}</div>
              </div>
              {ink.ratio >= 4.5 ? (
                <Badge variant="outline" size="sm" className="tabular-nums">{ink.ratio}:1</Badge>
              ) : (
                <Badge tone="warning" size="sm" className="tabular-nums">{ink.ratio}:1</Badge>
              )}
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen name="Line" title="线与焦点" description="边框 1px；焦点是边框加深为中性灰，不引入彩色描边。">
        <div className="grid grid-cols-2 gap-4">
          {[
            { label: '分隔线、卡片', token: '--border', className: 'border border-border' },
            { label: '内容岛描边', token: 'border / 50%', className: 'border border-border/50' },
            { label: '悬停加深', token: 'ring / 50%', className: 'border border-ring/50' },
            { label: '焦点', token: '--ring', className: 'border border-ring ring-2 ring-ring/30' },
          ].map(line => (
            <div key={line.token} className="min-w-0">
              <div className={cn('h-12 rounded-lg bg-background', line.className)} />
              <div className="mt-2 text-xs font-medium text-foreground">{line.label}</div>
              <div className="font-mono text-[11px] text-muted-foreground">{line.token}</div>
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen
        name="Status"
        title="状态色"
        description="每个状态两档：基础色给图标、圆点、图形；*-ink 给文字和实底。基础色作文字时绿、橙只有约 3.2:1。"
        span={2}
        dos={['状态同时用图标或文字表达，色弱用户也能区分', '文字、数字、实底按钮一律用 *-ink']}
        donts={['用状态色装饰没有状态含义的东西（分类、Agent、图表系列）', '整段彩色正文：颜色只给图标，正文保持墨色']}
      >
        <div className="overflow-x-auto scrollbar-app-thin">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border/70 text-xs text-muted-foreground">
                <th scope="col" className="h-8 pr-3 font-medium">语义</th>
                <th scope="col" className="h-8 px-3 font-medium">标记（基础色）</th>
                <th scope="col" className="h-8 px-3 font-medium">文字（ink）</th>
                <th scope="col" className="h-8 px-3 font-medium">浅底</th>
                <th scope="col" className="h-8 px-3 font-medium">实底</th>
                <th scope="col" className="h-8 pl-3 text-right font-medium">对比度 基础 / ink</th>
              </tr>
            </thead>
            <tbody>
              {STATUS_ROWS.map(row => {
                const Glyph = row.icon
                return (
                  <tr key={row.tone} className="border-b border-border/40 last:border-0">
                    <td className="py-2.5 pr-3">
                      <div className="text-[13px] font-medium text-foreground">{row.name}</div>
                      <div className="text-xs text-muted-foreground">{row.meaning}</div>
                    </td>
                    <td className="px-3">
                      <span className="flex items-center gap-2">
                        <Glyph aria-hidden="true" className={cn('size-4', TONE_MARK[row.tone])} />
                        <span className={cn('size-2 rounded-full', TONE_DOT[row.tone])} />
                        <Code>{row.base}</Code>
                      </span>
                    </td>
                    <td className="px-3">
                      <span className={cn('text-[13px] font-medium', TONE_INK[row.tone])}>+12 · 3 天</span>
                      <Code className="ml-2">{row.ink}</Code>
                    </td>
                    <td className="px-3"><Badge tone={row.tone}>{row.meaning.split('、')[0]}</Badge></td>
                    <td className="px-3"><Badge tone={row.tone} variant="solid">{row.meaning.split('、')[0]}</Badge></td>
                    <td className="pl-3 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                      <span className={row.baseRatio < 4.5 ? 'text-warning-ink' : undefined}>{row.baseRatio.toFixed(2)}</span>
                      {' / '}
                      <span className="text-foreground/80">{row.inkRatio.toFixed(2)}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Specimen>

      <Specimen
        name="Project"
        title="项目标识色"
        description="8 色按项目名哈希分配（components/task/adapters.ts）。项目色只出现在圆点和项目标签上。"
        donts={['用项目色做大面积底色或按钮色']}
      >
        <div className="grid grid-cols-4 gap-x-4 gap-y-3">
          {PROJECT_COLORS.map(color => (
            <span key={color} className="flex min-w-0 items-center gap-2">
              <ProjectDot color={color} className="size-2.5" />
              <span className="truncate font-mono text-[11px] text-muted-foreground">{color.replace('text-', '')}</span>
            </span>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {DEMO_PROJECTS.map(project => <ProjectTag key={project.name} name={project.name} color={project.color} />)}
        </div>
        <Caption className="mt-2">项目标签：文字从项目色渐变到灰，长名自动截短（payment-gateway-service → payment..）。</Caption>
      </Specimen>

      <Specimen
        name="Viz ink"
        title="图表墨阶"
        description="图表只用一种颜色的深浅：主数据墨色、对比用灰、计划用斜纹。序数（漏斗、分桶）只取 2–6 档。"
        dos={['数值越大越深；零值用最浅的 0 档而不是留白']}
        donts={['给类别分配彩虹色——超过 5 类就合并成「其他」或改用表格']}
      >
        <div className="flex h-10 overflow-hidden rounded-lg ring-1 ring-inset ring-black/[0.05]">
          {VIZ_RAMP.map(color => <div key={color} className="flex-1" style={{ background: color }} />)}
        </div>
        <div className="mt-2 grid grid-cols-7 gap-1.5">
          {RAMP_INFO.map((step, index) => (
            <div key={step.hex} className="min-w-0">
              <div className="font-mono text-[11px] text-foreground/80">viz-{index}</div>
              <div className="font-mono text-[11px] tabular-nums text-muted-foreground">{step.ratio}:1</div>
              <div className="mt-0.5 text-xs leading-[18px] text-muted-foreground">{step.usage}</div>
            </div>
          ))}
        </div>
        <Legend
          className="mt-4"
          items={[
            { label: '实际', swatch: 'solid', color: VIZ.ink },
            { label: '上期 / 对比', swatch: 'solid', color: VIZ.context },
            { label: '计划 / 剩余', swatch: 'hatch', color: VIZ.plan },
            { label: '目标', swatch: 'dashed', color: VIZ.ink },
          ]}
        />
      </Specimen>

      <Specimen
        name="Terminal"
        title="终端色"
        description={<>终端是全站唯一的常驻深色面，配色沿用 VS Code Dark。界面层（标签栏、分隔线、悬停）和程序输出（ANSI 色）都是 <Code className="whitespace-nowrap">--terminal-*</Code> 变量。</>}
        span={2}
        dos={['选中的标签、行用 bg-terminal：和终端正文同一种材质，表示「打开的就是它」', 'xterm 用 readTerminalTheme() 取色；终端里的状态点用 ANSI 色']}
        donts={['终端以外出现深色面；终端里弹出的菜单也用普通的浅色 Menu / Popover', '在代码里另抄一份终端色值']}
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <div aria-hidden="true" className="overflow-hidden rounded-lg bg-terminal">
              <div className="flex items-end gap-0.5 bg-terminal-chrome px-1.5 pt-1.5">
                <TerminalTab state="selected" dot="bg-terminal-green">pnpm dev</TerminalTab>
                <TerminalTab state="hover" dot="bg-terminal-blue">vitest</TerminalTab>
                <TerminalTab state="idle" dot="bg-terminal-red">build</TerminalTab>
                <span className="mb-2 ml-auto h-4 w-px bg-terminal-border" />
                <span className="mb-1 flex size-7 items-center justify-center rounded-md text-terminal-muted-foreground">
                  <Plus className="size-3.5" />
                </span>
              </div>
              <div className="p-3 font-mono text-xs leading-5">
                <div className="text-terminal-foreground"><span className="text-terminal-bright-black">$ </span>pnpm dev</div>
                <div className="text-terminal-bright-black">&gt; vite --host</div>
                <div className="text-terminal-green">VITE v7.1.3 ready in 412 ms</div>
                <div className="text-terminal-foreground">Local: <span className="text-terminal-cyan">http://localhost:5173/</span></div>
                <div className="text-terminal-yellow">(!) Port 5173 is in use, trying another one…</div>
              </div>
            </div>
            <Caption className="mt-2">选中的标签和下面的终端连成一片；中间是悬停态，右边是未选中。</Caption>
            <div className="mt-5 grid grid-cols-4 gap-x-3 gap-y-3">
              {TERMINAL_ANSI.map(color => (
                <div key={color.name} className="min-w-0">
                  <span className="flex h-7 items-center justify-center rounded-md bg-terminal">
                    <span className={cn('size-2.5 rounded-full', color.className)} />
                  </span>
                  <div className="mt-1 truncate font-mono text-[11px] text-foreground/80">{color.name}</div>
                  <div className="text-xs text-muted-foreground">{color.usage}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="min-w-0">
            <div className="flex flex-col divide-y divide-border/50">
              {TERMINAL_TOKENS.map(item => (
                <div key={item.token} className="flex items-center gap-3 py-2 first:pt-0">
                  <span className="flex h-7 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-terminal">{item.preview}</span>
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11px] text-foreground/80">{item.token}</div>
                    <div className="text-xs leading-[18px] text-muted-foreground">{item.usage}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Specimen>
    </ShowcaseSection>
  )
}

/* ── 文字 ─────────────────────────────────────────────────── */

const TYPE_SCALE = [
  { spec: '26 / 36 · 500', className: 'text-[26px] leading-9 font-medium tracking-tight', sample: '你需要在 agent-tower 中做点什么？', usage: '首屏标题，每屏至多一个' },
  { spec: '22 / 30 · 600', className: 'text-[22px] leading-[30px] font-semibold tracking-tight', sample: '项目设置', usage: '页面与章节标题' },
  { spec: '15 / 24 · 400', className: 'text-[15px] leading-6', sample: '把左侧任务面板改成紧凑的两行布局', usage: '输入卡正文' },
  { spec: '14 / 22 · 400', className: 'text-sm leading-[22px]', sample: '重塑左侧任务面板样式与交互', usage: '正文、侧栏行（默认字号）' },
  { spec: '13 / 20 · 400', className: 'text-[13px] leading-5', sample: '在新标签页中打开 · 复制分支名', usage: '菜单项、按钮、表格、样张说明' },
  { spec: '12 / 18 · 500', className: 'text-xs leading-[18px] font-medium', sample: '待审查 · 运行中 · 已完成', usage: '徽章、表头、字段说明（中文最小）' },
  { spec: '11 / 16 · 400', className: 'text-[11px] leading-4 tabular-nums', sample: '12:04 · 1,284 · +412 −187 · ⌘K', usage: '单行数字：时间、计数、刻度' },
  { spec: '10 / 12 · 500', className: 'text-[10px] leading-3 font-medium', sample: 'P0 · KR1 · W42', usage: '拉丁编号、头像缩写（最小）' },
]

export function TypographySection() {
  return (
    <ShowcaseSection
      id="typography"
      description="系统字体栈，不加载网络字体。字号以 14px 为正文基准；中文最小 12px、行高不低于 1.5 倍，11px 和 10px 只留给数字与编号；字重只用 400 / 500 / 600。"
    >
      <Specimen
        name="Type scale"
        title="字号阶梯"
        span={2}
        dos={['同一区域最多三档字号；层级优先用字重和颜色拉开', '中文句子至少 12px、行高 1.5 倍以上：小字省下的空间不值得读者眯眼']}
        donts={['用 10–11px 写中文说明——11px 只给数字，10px 只给编号', '700 以上的字重和全大写中文']}
      >
        <div className="flex flex-col divide-y divide-border/50">
          {TYPE_SCALE.map(row => (
            <div key={row.spec} className="grid grid-cols-1 items-baseline gap-1 py-3 first:pt-0 last:pb-0 md:grid-cols-[112px_minmax(0,1fr)_240px] md:gap-6">
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{row.spec}</span>
              <span className={cn('min-w-0 truncate text-foreground', row.className)}>{row.sample}</span>
              <span className="text-xs text-muted-foreground">{row.usage}</span>
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen name="Family" title="字体" description="正文用系统无衬线；代码、分支、哈希、路径用等宽。">
        <div className="space-y-4">
          <div>
            <div className="text-xs text-muted-foreground">Sans · ui-sans-serif, system-ui</div>
            <p className="mt-1 text-[15px] text-foreground">Agent Tower 让多个 AI Agent 并行工作</p>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Mono · ui-monospace, SFMono-Regular, Menlo</div>
            <p className="mt-1 font-mono text-[13px] text-foreground">feat/design-system · 8721b9c · src/index.css</p>
          </div>
        </div>
      </Specimen>

      <Specimen name="Numerals" title="数字" description="会变化或需要上下对齐的数字一律 tabular-nums；千分位用逗号，大数用紧凑写法。">
        <div className="grid grid-cols-2 gap-6">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">比例数字（默认）</div>
            {['1,111', '8,888', '4,701'].map(value => <div key={value} className="text-right text-lg font-semibold text-foreground">{value}</div>)}
          </div>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">等宽数字 tabular-nums</div>
            {['1,111', '8,888', '4,701'].map(value => <div key={value} className="text-right text-lg font-semibold tabular-nums text-foreground">{value}</div>)}
          </div>
        </div>
        <Caption className="mt-3">紧凑写法：1,284 · 12.9K · 1.28M；负号用「−」（U+2212），与加号同宽。</Caption>
      </Specimen>
    </ShowcaseSection>
  )
}

/* ── 间距、圆角与层级 ─────────────────────────────────────── */

const SPACING = [
  { px: 2, usage: '图表分段间隙、头像叠放描边' },
  { px: 4, usage: '紧凑的图标与文字、标签内边距' },
  { px: 6, usage: '胶囊内图标与文字' },
  { px: 8, usage: '侧栏外边距 · 行内边距 · 内容岛外边距' },
  { px: 10, usage: '行内图标与标题' },
  { px: 12, usage: '卡片内元素、表单字段之间' },
  { px: 16, usage: '卡片内边距、卡片之间' },
  { px: 24, usage: '区块之间' },
  { px: 32, usage: '宽屏页面内边距' },
  { px: 48, usage: '章节之间' },
]

const CONTROL_SIZES: { size: ButtonSize; px: number; usage: string }[] = [
  { size: 'xs', px: 24, usage: '行内操作、图表工具' },
  { size: 'sm', px: 28, usage: '胶囊、工具栏、分段' },
  { size: 'md', px: 32, usage: '默认：与侧栏行同高' },
  { size: 'lg', px: 36, usage: '表单输入、对话框按钮' },
  { size: 'xl', px: 44, usage: '首屏 CTA、触屏行' },
]

const RADII = [
  { label: '4', token: 'rounded', className: 'rounded', usage: '标签、键帽、优先级、数据端' },
  { label: '6', token: 'rounded-sm', className: 'rounded-sm', usage: '气泡收尖的那个角' },
  { label: '8', token: 'rounded-md', className: 'rounded-md', usage: '侧栏行、按钮、菜单项' },
  { label: '10', token: 'rounded-lg', className: 'rounded-lg', usage: '菜单、输入框、代码块、提示条' },
  { label: '14', token: 'rounded-xl', className: 'rounded-xl', usage: '内容岛、卡片、输入卡、对话框' },
  { label: '∞', token: 'rounded-full', className: 'rounded-full', usage: '胶囊、徽章、头像、开关' },
]

const ELEVATIONS = [
  { name: '平面', token: 'border', className: 'border border-border/70', usage: '内容岛、卡片：只有 1px 边' },
  { name: '浮起', token: 'shadow-raised', className: 'shadow-raised ring-1 ring-border/80', usage: '选中行、按钮、开关滑块' },
  { name: '弹出', token: 'shadow-popover', className: 'shadow-popover ring-1 ring-border/60', usage: '菜单、下拉、气泡卡' },
  { name: '覆盖', token: 'shadow-overlay', className: 'shadow-overlay ring-1 ring-border/60', usage: '对话框、拖拽中的行' },
]

export function LayoutSection() {
  return (
    <ShowcaseSection
      id="layout"
      description="4px 网格；控件高度、圆角、阴影各只有一组固定档位。新组件先从这里取值，取不到再讨论要不要加档。"
    >
      <Specimen name="Spacing" title="间距" description="4px 网格，2 / 6 / 10 只用于组件内部的细调。">
        <div className="flex flex-col gap-2">
          {SPACING.map(space => (
            <div key={space.px} className="flex items-center gap-3">
              <span className="w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-foreground/80">{space.px}</span>
              <span className="w-12 shrink-0">
                <span className="block h-2 rounded-[2px] bg-viz-6" style={{ width: space.px }} />
              </span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{space.usage}</span>
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen name="Control height" title="控件高度" description="五档高度对应按钮的 xs–xl；同一行里的控件必须同高。">
        <div className="flex flex-col gap-3">
          {CONTROL_SIZES.map(control => (
            <div key={control.size} className="flex items-center gap-3">
              <span className="w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-foreground/80">{control.px}</span>
              <span className="w-24 shrink-0">
                <Button size={control.size}>按钮 {control.size}</Button>
              </span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{control.usage}</span>
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen name="Radius" title="圆角" description="由 --radius（10px）派生；外层容器的圆角 ≥ 内层：内容岛 14 → 输入框 10 → 行 8。">
        <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3">
          {RADII.map(radius => (
            <div key={radius.token} className="min-w-0">
              <div className={cn('size-14 border border-foreground/25 bg-foreground/[0.03]', radius.className)} />
              <div className="mt-2.5 flex min-w-0 items-baseline gap-1.5 font-mono text-[11px]">
                <span className="text-foreground/80">{radius.label}</span>
                <span className="truncate text-muted-foreground">{radius.token}</span>
              </div>
              <p className="mt-0.5 text-xs leading-[18px] text-muted-foreground">{radius.usage}</p>
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen name="Elevation" title="层级" description="四档，越高越少见。阴影都很淡，层级主要靠白在灰上。" canvas="chrome">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {ELEVATIONS.map(level => (
            <div key={level.token} className="min-w-0">
              <div className={cn('h-16 rounded-lg bg-background', level.className)} />
              <div className="mt-2.5 text-xs font-medium text-foreground">{level.name}</div>
              <div className="font-mono text-[11px] text-muted-foreground">{level.token}</div>
              <p className="mt-1 text-xs leading-[18px] text-muted-foreground">{level.usage}</p>
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen
        name="App shell"
        title="页面骨架"
        description="主页的三段式：48px 顶栏 · 可拖拽侧栏（默认 400，260–600）· 内容岛（右下各留 8px，圆角 14，描边 border/50）。"
        span={2}
      >
        <div className="relative mx-auto flex h-56 max-w-3xl flex-col overflow-hidden rounded-lg bg-sidebar ring-1 ring-border">
          <div className="flex h-9 shrink-0 items-center gap-2 px-3">
            <span className="h-2 w-14 rounded-full bg-foreground/80" />
            <span className="h-1.5 w-16 rounded-full bg-foreground/20" />
            <span className="ml-auto h-4 w-4 rounded-[4px] bg-foreground/10" />
            <span className="font-mono text-[11px] text-muted-foreground">顶栏 48</span>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="flex w-[34%] shrink-0 flex-col gap-1 px-2 py-1">
              <span className="mb-1 h-6 rounded-md bg-background shadow-raised ring-1 ring-border/80" />
              <span className="h-1.5 w-10 rounded-full bg-foreground/20" />
              {[62, 48, 70, 40].map((width, index) => (
                <span key={index} className={cn('flex h-5 items-center gap-1.5 rounded-[5px] px-1.5', index === 1 && 'bg-background shadow-raised ring-1 ring-border/80')}>
                  <span className="size-2 rounded-full ring-[1.5px] ring-inset ring-foreground/30" />
                  <span className="h-1.5 rounded-full bg-foreground/40" style={{ width: `${width}%` }} />
                </span>
              ))}
              <span className="mt-auto font-mono text-[11px] text-muted-foreground">侧栏 400（260–600）</span>
            </div>
            <div className="w-1 shrink-0" />
            <div className="mb-2 mr-2 flex min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-border/50 bg-background">
              <span className="h-2 w-40 max-w-[70%] rounded-full bg-foreground/70" />
              <span className="h-12 w-64 max-w-[80%] rounded-xl border border-border shadow-raised" />
              <span className="font-mono text-[11px] text-muted-foreground">内容岛 · rounded-xl · mb-2 mr-2</span>
            </div>
          </div>
        </div>
      </Specimen>
    </ShowcaseSection>
  )
}
