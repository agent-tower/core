import { AgentLogo } from '@/components/agent/AgentLogo'
import {
  BarChart,
  ChartFrame,
  DonutChart,
  formatNumber,
  formatPercent,
  formatSignedNumber,
  FunnelChart,
  Legend,
  LineChart,
  RankedBars,
  ScatterChart,
  SERIES_COLOR,
  SlopeChart,
  stackColors,
  StackedBarChart,
  STATUS_MARK,
  VIZ,
  WaffleChart,
  type ChartTableData,
} from '@/design-system'
import { getAgentLabel } from '@/lib/agent-meta'
import {
  AGENT_SESSIONS,
  COMPLETED_CURRENT,
  COMPLETED_PREVIOUS,
  DAY_LABELS,
  DURATION_BUCKETS,
  DURATION_DATA,
  FIRST_PASS_RATE,
  MERGED_ACTUAL,
  MERGED_PLAN,
  SESSION_POINTS,
  TASK_FUNNEL,
  WEEK_LABELS,
} from '../demo-data'
import { Caption, ShowcaseSection, Specimen } from '../showcase'

/* ── 趋势与对比 ───────────────────────────────────────────── */

const LINE_TABLE: ChartTableData = {
  columns: [
    { key: 'day', header: '日期' },
    { key: 'current', header: '本期', align: 'right' },
    { key: 'previous', header: '上期', align: 'right' },
  ],
  rows: DAY_LABELS.map((day, index) => ({ day, current: COMPLETED_CURRENT[index], previous: COMPLETED_PREVIOUS[index] })),
}

const BAR_TABLE: ChartTableData = {
  columns: [
    { key: 'week', header: '周' },
    { key: 'actual', header: '实际', align: 'right' },
    { key: 'plan', header: '计划', align: 'right' },
  ],
  rows: WEEK_LABELS.map((week, index) => ({ week, actual: MERGED_ACTUAL[index], plan: MERGED_PLAN[index] })),
}

const SLOPE_TABLE: ChartTableData = {
  columns: [
    { key: 'agent', header: 'Agent' },
    { key: 'start', header: '9 月', align: 'right' },
    { key: 'end', header: '10 月', align: 'right' },
  ],
  rows: FIRST_PASS_RATE.map(item => ({ agent: item.label, start: formatPercent(item.start), end: formatPercent(item.end) })),
}

export function TrendsSection() {
  return (
    <ShowcaseSection
      id="trends"
      description="随时间变化用折线（连续）或柱图（分期）；两期之间谁变了用斜率图。主系列墨色，对比系列灰色，计划与目标用虚线或斜纹。"
    >
      <Specimen
        name="LineChart"
        title="折线图"
        description="2px 线，悬停出现十字线与数值卡；竖线标出发布日，虚线是目标。方向键可逐点移动。"
        span={2}
        dos={['每张图都能切到表格（右上角按钮）——数值不能只靠悬停读到']}
        donts={['双 Y 轴', '超过 3 条线：拆成小多图或改用表格']}
        bodyClassName="p-0"
      >
        <ChartFrame
          bare
          className="p-5"
          title="每日完成任务"
          subtitle="10 月 1 日 – 14 日 · 个"
          legend={(
            <Legend
              items={[
                { label: '本期', swatch: 'line', color: SERIES_COLOR.ink },
                { label: '上期（按星期对齐）', swatch: 'line', color: SERIES_COLOR.context },
              ]}
            />
          )}
          table={LINE_TABLE}
          footnote="周末明显回落；v1.2 发布后，完成量连续 3 个工作日高于目标线。"
        >
          <LineChart
            aria-label="每日完成任务，本期与上期对比"
            labels={DAY_LABELS}
            series={[
              { id: 'current', label: '本期', values: COMPLETED_CURRENT, area: true },
              { id: 'previous', label: '上期', values: COMPLETED_PREVIOUS, variant: 'context' },
            ]}
            marker={{ index: 8, label: 'v1.2 发布' }}
            baseline={{ value: 25, label: '目标' }}
          />
        </ChartFrame>
      </Specimen>

      <Specimen name="BarChart" title="柱图" description="柱宽封顶 24px，4px 数据端圆角；计划用斜纹并排。只在最后一组柱顶标数。" bodyClassName="p-0">
        <ChartFrame
          bare
          className="p-5"
          title="每周合并的 PR"
          subtitle="实际 vs 计划 · 个"
          legend={(
            <Legend
              items={[
                { label: '实际', swatch: 'solid', color: VIZ.ink },
                { label: '计划', swatch: 'hatch', color: VIZ.plan },
              ]}
            />
          )}
          table={BAR_TABLE}
          footnote="W42 截至周三，距本周计划还差 14 个。"
        >
          <BarChart
            aria-label="每周合并的 PR，实际与计划"
            labels={WEEK_LABELS}
            series={[
              { id: 'actual', label: '实际', values: MERGED_ACTUAL },
              { id: 'plan', label: '计划', values: MERGED_PLAN, variant: 'plan' },
            ]}
          />
        </ChartFrame>
      </Specimen>

      <Specimen name="SlopeChart" title="斜率图" description="两个时间点之间谁升谁降：主角墨色加粗，其余为灰色背景线；端点标签相撞时自动错开。" bodyClassName="p-0">
        <ChartFrame bare className="p-5" title="一次通过审查的比例" subtitle="9 月 → 10 月 · 按 Agent" table={SLOPE_TABLE}>
          <SlopeChart
            aria-label="各 Agent 一次通过审查比例的变化"
            items={FIRST_PASS_RATE}
            startLabel="9 月"
            endLabel="10 月"
            formatValue={value => formatPercent(value)}
            formatChange={item => `${formatSignedNumber(Math.round((item.end - item.start) * 100))} pt`}
          />
        </ChartFrame>
      </Specimen>
    </ShowcaseSection>
  )
}

/* ── 构成与分布 ───────────────────────────────────────────── */

const DURATION_COLORS = stackColors(DURATION_BUCKETS.length)

const STATUS_SEGMENTS = [
  { id: 'done', label: '已完成', value: 412, color: STATUS_MARK.success },
  { id: 'running', label: '运行中', value: 38, color: STATUS_MARK.info },
  { id: 'review', label: '待审查', value: 21, color: STATUS_MARK.warning },
  { id: 'pending', label: '待开始', value: 64, color: STATUS_MARK.neutral },
]

export function CompositionSection() {
  const sessionTotal = AGENT_SESSIONS.reduce((sum, item) => sum + item.value, 0)
  return (
    <ShowcaseSection
      id="composition"
      description="构成用堆叠柱、环图、方格图；分布用排行条、漏斗、散点。类别默认用墨阶由深到浅；只有当类别本身就是状态时才用状态色。"
    >
      <Specimen name="StackedBarChart" title="堆叠柱" description="看构成随时间的变化。分段之间 2px 白缝，最深的一段放在最下面；只标最后一根的合计。" bodyClassName="p-0">
        <ChartFrame
          bare
          className="p-5"
          title="任务耗时分布"
          subtitle="按周 · 个"
          legend={<Legend items={DURATION_BUCKETS.map((bucket, index) => ({ label: bucket.label, swatch: 'solid', color: DURATION_COLORS[index] }))} />}
        >
          <StackedBarChart aria-label="每周任务耗时分布" labels={WEEK_LABELS} segments={DURATION_BUCKETS} data={DURATION_DATA} />
        </ChartFrame>
      </Specimen>

      <Specimen
        name="DonutChart"
        title="环图"
        description="部分与整体，不超过 5 段。中心放合计，悬停某段时换成该段的值；右侧数值表同时也是图例。"
        donts={['超过 5 段——把小的合并成「其他」', '用环图比较两期——改用柱图']}
      >
        <div className="flex flex-col gap-6">
          <DonutChart aria-label="任务状态构成" segments={STATUS_SEGMENTS} centerLabel="个任务" />
          <DonutChart
            aria-label="各 Agent 会话占比"
            segments={AGENT_SESSIONS.map(item => ({ id: item.id, label: getAgentLabel(item.agent), value: item.value }))}
            centerLabel="次会话"
            size={120}
            thickness={12}
          />
        </div>
        <Caption className="mt-3">上：类别就是状态，用状态色；下：普通类别，用墨阶由深到浅。</Caption>
      </Specimen>

      <Specimen name="WaffleChart" title="方格图" description="一个比例的直观版：100 格，实心是完成，斜纹是进行中。">
        <div className="flex flex-wrap items-center gap-6">
          <WaffleChart aria-label="迭代完成 62%，进行中 14%" value={0.62} secondary={0.14} cellSize={12} />
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-[26px] font-semibold leading-8 tracking-tight text-foreground">62%</div>
              <div className="text-xs text-muted-foreground">迭代任务已完成</div>
            </div>
            <Legend
              className="flex-col items-start gap-1.5"
              items={[
                { label: '已完成', swatch: 'solid', color: VIZ.ink, value: '62' },
                { label: '进行中', swatch: 'hatch', color: VIZ.plan, value: '14' },
                { label: '未开始', swatch: 'solid', color: VIZ.empty, value: '24' },
              ]}
            />
          </div>
        </div>
      </Specimen>

      <Specimen name="RankedBars" title="排行条" description="谁多谁少：按值降序，前三名序号加深；条长相对最大值。" >
        <RankedBars
          aria-label="近 30 天各 Agent 会话数"
          items={AGENT_SESSIONS.map(item => ({
            id: item.id,
            label: getAgentLabel(item.agent),
            value: item.value,
            meta: formatPercent(item.value / sessionTotal),
            icon: <AgentLogo agentType={item.agent} className="size-4" />,
          }))}
        />
      </Specimen>

      <Specimen name="FunnelChart" title="漏斗" description="逐级转化：每级右侧是占首级的比例，级间是转化率；流失最大的一级用警告色标出。">
        <FunnelChart aria-label="任务从创建到合并的转化" stages={TASK_FUNNEL} formatValue={value => formatNumber(value)} />
      </Specimen>

      <Specimen name="ScatterChart" title="散点图" description="两个量有没有关系：点是灰的，需要注意的离群点用墨色并直接标注。" bodyClassName="p-0">
        <ChartFrame
          bare
          className="p-5"
          title="会话时长与改动行数"
          subtitle="近 30 天 · 每个点是一次会话"
          footnote="两个离群点：一次卡在依赖安装（时长长、改动少），一次是批量格式化（时长短、改动多）。"
        >
          <ScatterChart
            aria-label="会话时长与改动行数的关系"
            points={SESSION_POINTS}
            xLabel="会话时长（分钟）"
            yLabel="改动行数"
            height={260}
          />
        </ChartFrame>
      </Specimen>
    </ShowcaseSection>
  )
}
