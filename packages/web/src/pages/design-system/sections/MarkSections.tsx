import type { ReactNode } from 'react'
import { Activity, Bot, CircleCheck, Clock, GitPullRequest, Users } from 'lucide-react'
import {
  Delta,
  formatNumber,
  formatPercent,
  formatSignedPercent,
  HealthBadge,
  HeroFigure,
  Legend,
  Meter,
  ObjectiveCard,
  Ring,
  Sparkline,
  StateSquare,
  StatGroup,
  StatTile,
  Track,
  TreeList,
  VIZ,
  VIZ_RAMP,
  type Health,
  type SquareState,
} from '@/design-system'
import { cn } from '@/lib/utils'
import { COMPLETED_CURRENT, COMPLETED_PREVIOUS } from '../demo-data'
import { Caption, Code, DemoRow, ShowcaseSection, Specimen } from '../showcase'

/* ── 展示原则 ─────────────────────────────────────────────── */

function VizPrinciple({ title, en, art, children }: { title: string; en: string; art: ReactNode; children: ReactNode }) {
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-background">
      <div aria-hidden="true" className="flex h-32 items-center justify-center border-b border-border/50 px-6">{art}</div>
      <div className="px-5 pb-5 pt-4">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{en}</span>
        </div>
        <p className="mt-1.5 text-[13px] leading-[22px] text-muted-foreground">{children}</p>
      </div>
    </article>
  )
}

const HATCH_BG = 'hatch bg-viz-0 text-viz-3'

export function VizPrinciplesSection() {
  const bars = [0.55, 0.7, 0.62, 0.84, 0.48]
  const line = [18, 22, 17, 26, 24, 30, 28, 34]
  const linePath = line.map((value, index) => `${index === 0 ? 'M' : 'L'}${8 + index * 22} ${76 - value * 1.8}`).join(' ')
  return (
    <ShowcaseSection
      id="viz-principles"
      columns={2}
      description="展示组件是一套「画法」，不是一堆图表类型。四条原则决定了所有图表、统计卡、清单长什么样；新组件先回答这四个问题。"
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:col-span-2 2xl:grid-cols-4">
        <VizPrinciple
          title="实与虚"
          en="Actual vs plan"
          art={(
            <div className="flex h-20 items-end gap-3">
              {bars.map((value, index) => (
                <div key={index} className="flex h-full items-end gap-[2px]">
                  <span className="w-3 rounded-t-[3px] bg-viz-6" style={{ height: `${value * 100}%` }} />
                  <span className={cn('w-3 rounded-t-[3px]', HATCH_BG)} style={{ height: `${Math.min(1, value + 0.15) * 100}%` }} />
                </div>
              ))}
            </div>
          )}
        >
          已经发生的用实心墨色；计划、预期、剩余用斜纹或虚线。读者一眼分清「做到了多少」和「应该到多少」。
        </VizPrinciple>
        <VizPrinciple
          title="一种颜色"
          en="One ink"
          art={(
            <div className="grid grid-cols-7 gap-[3px]">
              {[0, 1, 2, 4, 3, 5, 6, 1, 2, 3, 2, 4, 6, 5, 0, 2, 3, 5, 4, 6, 6].map((step, index) => (
                <span key={index} className="size-5 rounded-[3px]" style={{ background: VIZ_RAMP[step] }} />
              ))}
            </div>
          )}
        >
          所有图表只用 Charcoal 的深浅，数值越大越深。需要并列的系列最多两个：主角墨色，对比用灰。
        </VizPrinciple>
        <VizPrinciple
          title="状态才有颜色"
          en="Color means status"
          art={(
            <div className="flex h-20 items-end gap-2">
              {[0.5, 0.65, 0.4, 0.9, 0.55, 0.7].map((value, index) => (index === 3 ? (
                <span key={index} className="flex w-4 flex-col items-center gap-1">
                  <span className="whitespace-nowrap rounded bg-destructive/10 px-1 text-[10px] font-medium leading-4 text-destructive-ink">逾期</span>
                  <span className="w-4 rounded-t-[3px] bg-destructive" style={{ height: value * 60 }} />
                </span>
              ) : (
                <span key={index} className="w-4 rounded-t-[3px] bg-viz-2" style={{ height: value * 60 }} />
              )))}
            </div>
          )}
        >
          图表里出现颜色，就意味着有事要处理：逾期红、风险橙。颜色必须配图标或文字，其余全部灰阶。
        </VizPrinciple>
        <VizPrinciple
          title="今天与基准"
          en="Today & baseline"
          art={(
            <svg viewBox="0 0 176 84" className="h-20 w-44">
              <line x1="0" x2="176" y1="30" y2="30" stroke={VIZ.ink} strokeWidth="1" strokeDasharray="3 3" />
              <path d={linePath} fill="none" stroke={VIZ.ink} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              <line x1="140" x2="140" y1="4" y2="80" stroke={VIZ.ink} strokeOpacity="0.5" strokeWidth="1" />
              <text x="143" y="12" fontSize="9" fill="var(--muted-foreground)">今天</text>
              <text x="2" y="26" fontSize="9" fill="var(--muted-foreground)">目标</text>
            </svg>
          )}
        >
          时间轴用竖线标出今天，水平虚线标出目标或均值——数字只有放在参照旁边才有意义。
        </VizPrinciple>
      </div>

      <Specimen
        name="Form"
        title="选型"
        description="先问「读者要回答什么问题」，再选形式。"
        span={2}
        dos={['一个数字就是答案时用统计卡，不要画图', '需要逐行比较时用表格']}
        donts={['饼图超过 5 块、双 Y 轴、3D、渐变填充', '用图表装饰没有问题要回答的版面']}
      >
        <div className="grid gap-x-8 gap-y-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
          {[
            ['现在是多少？', '统计卡 · 主数字 · 用量表'],
            ['离目标还差多少？', '目标卡 · 进度条 · 进度环'],
            ['随时间怎么变？', '折线（连续）· 柱图（分期）'],
            ['谁多谁少？', '排行条 · 柱图'],
            ['由什么构成？', '堆叠柱 · 环图 · 方格图'],
            ['两期之间谁变了？', '斜率图'],
            ['两个量有没有关系？', '散点图'],
            ['什么时候、在哪儿集中？', '热力表 · 日历热力'],
          ].map(([question, answer]) => (
            <div key={question} className="flex flex-col border-l border-border pl-3">
              <span className="font-medium text-foreground">{question}</span>
              <span className="text-muted-foreground">{answer}</span>
            </div>
          ))}
        </div>
      </Specimen>
    </ShowcaseSection>
  )
}

/* ── 画法 ─────────────────────────────────────────────────── */

const SQUARES: { state: SquareState; label: string }[] = [
  { state: 'todo', label: '未开始' },
  { state: 'doing', label: '进行中' },
  { state: 'done', label: '已完成' },
  { state: 'late', label: '逾期' },
  { state: 'cancelled', label: '已取消' },
]

const HEALTHS: Health[] = ['not-started', 'on-track', 'ahead', 'at-risk', 'off-track', 'done']

const STREAK: SquareState[] = ['done', 'done', 'done', 'late', 'done', 'done', 'done', 'done', 'cancelled', 'done', 'done', 'doing', 'todo', 'todo']

export function MarksSection() {
  return (
    <ShowcaseSection
      id="marks"
      description="图表与展示组件的最小零件。每个零件只有一种画法：同样的意思在任何地方都画成同样的样子。"
    >
      <Specimen name="Legend" title="图例" description="两个及以上系列才放图例；色块形状与图中标记一致（实心 / 斜纹 / 线 / 虚线）。">
        <div className="flex flex-col gap-4">
          <Legend
            items={[
              { label: '实际', swatch: 'solid', color: VIZ.ink, value: '1,284' },
              { label: '计划', swatch: 'hatch', color: VIZ.plan, value: '1,400' },
              { label: '上期', swatch: 'solid', color: VIZ.context },
            ]}
          />
          <Legend
            items={[
              { label: '本期', swatch: 'line', color: VIZ.ink },
              { label: '目标', swatch: 'dashed', color: VIZ.ink },
              { label: '当前值', swatch: 'dot', color: VIZ.ink },
              { label: '预测区间', swatch: 'outline', color: VIZ.plan },
            ]}
          />
        </div>
      </Specimen>

      <Specimen
        name="Delta"
        title="变化量"
        description="箭头 + 带符号的数值 + 对比口径。颜色看「好坏」而不是「涨跌」：成本涨了是红的。"
        dos={['永远写明对比口径：「比上周」']}
      >
        <div className="flex flex-col gap-3">
          <DemoRow label="越多越好"><Delta value={0.18} period="比上周" /><Delta value={-0.07} period="比上周" /></DemoRow>
          <DemoRow label="越少越好"><Delta value={-0.12} goodWhen="down" period="审查耗时" /><Delta value={0.09} goodWhen="down" period="Token 成本" /></DemoRow>
          <DemoRow label="无好坏"><Delta value={0.04} goodWhen="none" period="会话数" /><Delta value={0} period="持平" /></DemoRow>
          <DemoRow label="数值 · md"><Delta value={12} format="number" size="md" period="个任务" /></DemoRow>
        </div>
      </Specimen>

      <Specimen name="Track" title="进度条" description="墨色实际 + 浅灰轨道；竖线是「此刻应到的位置」，落后多少一眼可见。">
        <div className="flex flex-col gap-4">
          {[
            { label: '迭代进度', value: 0.62, expected: 0.7, tone: 'ink' as const },
            { label: '测试覆盖', value: 0.81, tone: 'ink' as const },
            { label: '磁盘用量', value: 0.78, tone: 'warning' as const },
            { label: '上下文窗口', value: 0.94, tone: 'danger' as const },
          ].map(item => (
            <div key={item.label}>
              <div className="mb-1.5 flex justify-between text-xs">
                <span className="text-foreground/85">{item.label}</span>
                <span className="font-medium tabular-nums text-foreground">{formatPercent(item.value)}</span>
              </div>
              <Track value={item.value} expected={item.expected} tone={item.tone} aria-label={item.label} />
            </div>
          ))}
          <DemoRow label="粗细">
            <Track value={0.5} size="xs" className="w-20" aria-label="xs" />
            <Track value={0.5} size="sm" className="w-20" aria-label="sm" />
            <Track value={0.5} size="md" className="w-20" aria-label="md" />
          </DemoRow>
        </div>
      </Specimen>

      <Specimen name="Ring" title="进度环" description="空间紧凑时代替进度条；中心放百分比或自定义内容。">
        <div className="flex flex-wrap items-center gap-6">
          <Ring value={0.42} size={40} aria-label="完成 42%" />
          <Ring value={0.66} size={64} expected={0.75} aria-label="完成 66%" />
          <Ring value={0.88} size={88} thickness={8} aria-label="完成 88%">
            <span className="flex flex-col items-center leading-tight">
              <span className="text-lg font-semibold tabular-nums text-foreground">22</span>
              <span className="text-[11px] text-muted-foreground">/ 25 任务</span>
            </span>
          </Ring>
          <Ring value={0.95} size={64} tone="danger" aria-label="配额 95%" />
        </div>
      </Specimen>

      <Specimen name="Sparkline" title="迷你走势" description="放在数字旁边，只回答「在涨还是在跌」；不画坐标轴。">
        <div className="flex flex-col gap-3">
          {[
            { label: '每日完成', values: COMPLETED_CURRENT, value: '33', area: true },
            { label: '上期同日', values: COMPLETED_PREVIOUS, value: '21', tone: 'context' as const },
            { label: '平均审查耗时', values: [22, 20, 21, 18, 19, 16, 15, 14, 15, 13, 14, 12], value: '12 分钟', baseline: 15 },
          ].map(item => (
            <div key={item.label} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-xs text-foreground/85">{item.label}</span>
              <Sparkline values={item.values} area={item.area} tone={item.tone} baseline={item.baseline} width={120} aria-label={item.label} />
              <span className="text-[13px] font-semibold tabular-nums text-foreground">{item.value}</span>
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen name="StateSquare" title="状态方块" description="图表里的最小状态单元（连续记录、排期格）：空心 → 半实 → 实心，逾期是唯一的彩色。它是数据标记，界面里的状态图标仍用 lucide 线性图标。">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            {SQUARES.map(item => (
              <span key={item.state} className="flex items-center gap-1.5 text-xs text-foreground/85">
                <StateSquare state={item.state} label={item.label} />
                {item.label}
              </span>
            ))}
          </div>
          <div>
            <Caption className="mb-1.5">近两周每日构建</Caption>
            <div className="flex gap-1">
              {STREAK.map((state, index) => <StateSquare key={index} state={state} size="md" label={`第 ${index + 1} 天`} />)}
            </div>
          </div>
        </div>
      </Specimen>

      <Specimen name="HealthBadge" title="健康度" description="目标、里程碑、TeamRun 共用。正常不上色；越需要处理越醒目。">
        <div className="flex flex-wrap gap-2">
          {HEALTHS.map(health => <HealthBadge key={health} health={health} />)}
        </div>
      </Specimen>

      <Specimen name="TreeList" title="树形清单" description="层级拆解（任务 → 子任务），每层带进度；层级超过 3 层就该换一种组织方式。" span={2}>
        <TreeList
          defaultCollapsed={['tree-3']}
          nodes={[
            {
              id: 'tree-1',
              label: '设计系统 v1',
              meta: 'TeamRun · 4 个 Agent',
              progress: 0.68,
              children: [
                { id: 'tree-1-1', label: '令牌与组件', meta: 'Claude Code', progress: 1 },
                {
                  id: 'tree-1-2',
                  label: '展示页',
                  meta: 'Claude Code',
                  progress: 0.55,
                  children: [
                    { id: 'tree-1-2-1', label: '基础与组件章节', progress: 0.9 },
                    { id: 'tree-1-2-2', label: '图表章节', progress: 0.3 },
                  ],
                },
                { id: 'tree-1-3', label: '视觉回归测试', meta: 'Codex', progress: 0.2 },
              ],
            },
            {
              id: 'tree-3',
              label: '主页迁移',
              meta: '下周开始',
              progress: 0,
              children: [{ id: 'tree-3-1', label: '侧栏换用 NavRow / TaskRow', progress: 0 }],
            },
          ]}
        />
      </Specimen>
    </ShowcaseSection>
  )
}

/* ── 目标 ─────────────────────────────────────────────────── */

export function GoalsSection() {
  return (
    <ShowcaseSection
      id="goals"
      description="目标卡回答「离目标还差多少、是否按计划」：整体进度环 + 健康度 + 每条关键结果的进度与预期线。"
    >
      <ObjectiveCard
        code="O1"
        title="让任务一次通过审查"
        meta="Q4 · 负责人 shitian · 截止 12 月 31 日"
        health="at-risk"
        progress={0.48}
        keyResults={[
          { id: 'kr1', code: 'KR1', title: '一次通过率从 62% 提到 75%', progress: 0.46, expected: 0.6, current: '68%' },
          { id: 'kr2', code: 'KR2', title: '平均审查轮次降到 1.5', progress: 0.35, expected: 0.6, current: '2.1 轮' },
          { id: 'kr3', code: 'KR3', title: '合并后回滚率低于 2%', progress: 0.9, expected: 0.6, current: '1.4%' },
        ]}
      />
      <ObjectiveCard
        code="O2"
        title="多 Agent 协作进入日常"
        meta="Q4 · TeamRun · 截止 12 月 31 日"
        health="on-track"
        progress={0.66}
        keyResults={[
          { id: 'kr4', code: 'KR1', title: '每周 TeamRun 任务 ≥ 30 个', progress: 0.73, expected: 0.6, current: '22 / 30' },
          { id: 'kr5', code: 'KR2', title: '团队拓扑模板 5 套', progress: 0.6, expected: 0.6, current: '3 / 5' },
          { id: 'kr6', code: 'KR3', title: 'Lead Agent 自动拆解准确率 80%', progress: 0.65, expected: 0.6, current: '78%' },
        ]}
      />
      <Specimen
        name="KeyResult"
        title="关键结果的读法"
        span={2}
        dos={['预期线 = 按时间均匀推进此刻应到的位置；进度条在线左边就是落后', '健康度由负责人判断，不由公式自动算']}
        donts={['用红绿给每条关键结果上色——只有整体健康度有颜色']}
      >
        <div className="grid gap-6 sm:grid-cols-3">
          {[
            { title: '落后', value: 0.35, expected: 0.6, text: '进度在预期线左侧' },
            { title: '按计划', value: 0.62, expected: 0.6, text: '进度贴着预期线' },
            { title: '领先', value: 0.9, expected: 0.6, text: '进度越过预期线' },
          ].map(item => (
            <div key={item.title}>
              <div className="mb-1.5 flex justify-between text-xs">
                <span className="font-medium text-foreground">{item.title}</span>
                <span className="tabular-nums text-muted-foreground">{formatPercent(item.value)} / 预期 {formatPercent(item.expected)}</span>
              </div>
              <Track value={item.value} expected={item.expected} aria-label={item.title} />
              <Caption className="mt-1.5">{item.text}</Caption>
            </div>
          ))}
        </div>
      </Specimen>
    </ShowcaseSection>
  )
}

/* ── 数字 ─────────────────────────────────────────────────── */

export function NumbersSection() {
  return (
    <ShowcaseSection
      id="numbers"
      description="一个数字就是答案时不要画图。数字要有单位、有对比、有走势中的一两样，不要三样都没有，也不要三样全塞满。"
    >
      <Specimen
        name="StatTile · StatGroup"
        title="统计卡"
        description="标签 · 数值 · 变化量（带口径）· 可选走势。一组 2–4 个，1px 细线分隔。"
        span={2}
        bodyClassName="p-0"
      >
        <StatGroup className="rounded-none border-0">
          <StatTile label="运行中的 Agent" icon={<Bot />} value="7" unit="个" delta={{ value: 2, format: 'number', goodWhen: 'none', period: '比昨天' }} />
          <StatTile label="今日完成任务" icon={<CircleCheck />} value="33" delta={{ value: 0.18, period: '比上周同日' }} trend={COMPLETED_CURRENT} />
          <StatTile label="平均审查耗时" icon={<Clock />} value="12" unit="分钟" delta={{ value: -0.12, goodWhen: 'down', period: '比上周' }} />
          <StatTile label="本月 Token" icon={<Activity />} value={formatNumber(1_284_000, { compact: true })} delta={{ value: 0.09, goodWhen: 'down', period: '比上月' }} footnote="配额 2M" />
        </StatGroup>
      </Specimen>

      <Specimen name="HeroFigure" title="主数字" description="一个视图只能有一个；56px，和正文同一款字体。">
        <HeroFigure
          label="本月由 Agent 完成的工时"
          value="186"
          unit="小时"
          delta={{ value: 0.24, period: '比上月' }}
          caption="按任务预估工时累计"
        />
      </Specimen>

      <Specimen name="Meter" title="用量表" description="有上限的资源。平时墨色；越过阈值整条换色并加图标，颜色不单独承载含义。">
        <div className="flex flex-col gap-4">
          <Meter label="本月 Token 配额" value={1_284_000} max={2_000_000} />
          <Meter label="工作树磁盘" value={41} max={50} formatValue={value => `${value} GB`} />
          <Meter label="并发会话" value={9} max={10} formatValue={value => String(value)} />
        </div>
      </Specimen>

      <Specimen
        name="Format"
        title="数字格式"
        description="formatNumber / formatPercent 统一格式化；表格、坐标轴、提示用同一套写法。"
        span={2}
      >
        <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
          {[
            ['整数千分位', '1284', formatNumber(1284)],
            ['紧凑写法', '1284000', formatNumber(1_284_000, { compact: true })],
            ['中文紧凑', '1736000（zh-CN）', formatNumber(1_736_000, { compact: true, locale: 'zh-CN' })],
            ['百分比', '0.6248', formatPercent(0.6248)],
            ['带符号变化', '−0.071', formatSignedPercent(-0.071)],
            ['小数位', '3.14159 · 1 位', formatNumber(3.14159, { maximumFractionDigits: 1 })],
          ].map(([name, input, output]) => (
            <div key={name} className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1.5">
              <span className="text-xs text-foreground/85">{name}</span>
              <span className="flex items-baseline gap-2">
                <Code>{input}</Code>
                <span className="text-[13px] font-semibold tabular-nums text-foreground">{output}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><Users className="size-3.5" />人数、次数：整数</span>
          <span className="flex items-center gap-1.5"><GitPullRequest className="size-3.5" />比例：最多 1 位小数</span>
          <span className="flex items-center gap-1.5"><Clock className="size-3.5" />时长：分钟 / 小时，不写秒</span>
        </div>
      </Specimen>
    </ShowcaseSection>
  )
}
