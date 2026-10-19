import { useState } from 'react'
import { AgentType } from '@agent-tower/shared'
import { Bot, Code2, GitMerge, Search } from 'lucide-react'
import logoUrl from '@/assets/agent-tower-logo.png'
import { AgentLogo } from '@/components/agent/AgentLogo'
import {
  ActivityFeed,
  AgentMark,
  Avatar,
  AvatarGroup,
  Badge,
  Bulletin,
  CalendarHeatmap,
  CodeBlock,
  CommitItem,
  DataTable,
  DeadlineList,
  DiffStat,
  EmptyState,
  FileChip,
  FileRow,
  GanttChart,
  HeatTable,
  Leaderboard,
  LiveDot,
  MessageBubble,
  MonthCalendar,
  ProcessSteps,
  ProjectDot,
  ProjectTag,
  PromptBlock,
  RelativeTime,
  ScaleLegend,
  Segmented,
  TaskStatusBadge,
  TerminalBlock,
  TextLink,
  Timeline,
  TodoList,
  TopologyTree,
  type DataColumn,
  type TodoItem,
} from '@/design-system'
import {
  ACTIVITY_START,
  ACTIVITY_VALUES,
  CALENDAR_EVENTS,
  DEMO_NOW,
  DEMO_PROJECTS,
  DEMO_TASKS,
  GANTT_START,
  GANTT_TASKS,
  PROJECT_WEEKDAY,
  WEEKDAY_LABELS,
  type DemoTask,
} from '../demo-data'
import { Caption, DemoRow, ShowcaseSection, Specimen } from '../showcase'

const MINUTE = 60_000

/* ── 清单 ─────────────────────────────────────────────────── */

const INITIAL_TODOS: TodoItem[] = [
  { id: 'todo-1', title: '审查「重塑左侧任务面板」的改动', state: 'doing', tag: <ProjectTag name="agent-tower" color="text-indigo-600" />, due: { label: '今天', tone: 'warning' } },
  { id: 'todo-2', title: '续期隧道证书', state: 'todo', tag: <ProjectTag name="desktop-shell" color="text-rose-600" />, due: { label: '逾期 1 天', tone: 'danger' } },
  { id: 'todo-3', title: '给 TeamRun 写拓扑模板说明', state: 'todo', due: { label: '10/17' } },
  { id: 'todo-4', title: '合并 v1.2 发布分支', state: 'done', due: { label: '10/09' } },
  { id: 'todo-5', title: '迁移旧的 Provider 配置', state: 'cancelled' },
]

function TodoDemo() {
  const [items, setItems] = useState(INITIAL_TODOS)
  const toggle = (id: string) => {
    setItems(current => current.map(item => (item.id === id ? { ...item, state: item.state === 'done' ? 'todo' : 'done' } : item)))
  }
  return <TodoList items={items} onToggle={toggle} />
}

function AgentAvatar({ agentType }: { agentType: AgentType }) {
  return (
    <span className="flex size-6 items-center justify-center rounded-full bg-background ring-1 ring-border">
      <AgentLogo agentType={agentType} className="size-3.5" />
    </span>
  )
}

export function ListsSection() {
  return (
    <ShowcaseSection
      id="lists"
      description="清单是最常见的展示形式：每行一件事，状态在左、元信息在右。行间 1px 细线，悬停浅灰；只有临近或逾期的日期才上色。"
    >
      <Specimen name="TodoList" title="待办" description="状态图标与任务状态同一套，可点击切换完成；顶部是各状态计数。逾期红、今天到期橙，其余日期灰。">
        <TodoDemo />
      </Specimen>

      <Specimen name="Timeline" title="日程" description="按天分组的时间线：起止时间对齐成列，竖条表示时长，进行中的一项竖条变黑。">
        <Timeline
          groups={[
            {
              id: 'today',
              title: '今天',
              caption: '10 月 14 日 周三',
              entries: [
                { id: 'tl-1', time: '09:30', endTime: '10:00', title: '站会', meta: '线上 · 6 人' },
                { id: 'tl-2', time: '10:00', endTime: '12:00', title: 'Claude Code：重塑任务面板', tag: <Badge size="sm" variant="dot" tone="success">已完成</Badge> },
                { id: 'tl-3', time: '14:00', endTime: '15:00', title: '设计评审：组件库', meta: '会议室 3' },
                { id: 'tl-4', time: '15:00', endTime: '16:30', title: 'TeamRun：设计系统展示页', active: true, tag: <LiveDot tone="info" label="进行中" /> },
                { id: 'tl-5', time: '17:00', title: 'TeamRun 演示' },
              ],
            },
            {
              id: 'tomorrow',
              title: '明天',
              caption: '10 月 15 日 周四',
              entries: [{ id: 'tl-6', time: '10:00', endTime: '11:00', title: '迭代周会', meta: '线上' }],
            },
          ]}
        />
      </Specimen>

      <Specimen name="ActivityFeed" title="动态" description="谁在什么时候做了什么。主语加粗，时间右对齐，附加内容缩进在下方。">
        <ActivityFeed
          entries={[
            {
              id: 'act-1',
              avatar: <AgentAvatar agentType={AgentType.CLAUDE_CODE} />,
              text: <><b className="font-medium text-foreground">Claude Code</b> 提交了 3 个文件</>,
              time: '4 分钟',
              detail: <span className="font-mono text-[11px]">feat(web): 重塑左侧任务面板样式与交互</span>,
            },
            {
              id: 'act-2',
              avatar: <Avatar name="林夏" size="sm" />,
              text: <><b className="font-medium text-foreground">林夏</b> 把任务移到了「待审查」</>,
              time: '12 分钟',
            },
            {
              id: 'act-3',
              avatar: <AgentAvatar agentType={AgentType.CODEX} />,
              text: <><b className="font-medium text-foreground">Codex</b> 开始执行「修复会话自动结束」</>,
              time: '25 分钟',
            },
            {
              id: 'act-4',
              avatar: (
                <span className="flex size-6 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground">
                  <GitMerge className="size-3.5" aria-hidden="true" />
                </span>
              ),
              text: <><b className="font-medium text-foreground">周远</b> 合并了 feat/approval-loop</>,
              time: '1 小时',
              detail: <DiffStat additions={865} deletions={233} />,
            },
          ]}
        />
      </Specimen>

      <Specimen name="DeadlineList" title="到期提醒" description="大号天数先抓住视线：逾期红、3 天内橙、其余墨色——越紧急越醒目。">
        <DeadlineList
          items={[
            { id: 'dl-1', days: -2, title: '隧道证书续期', meta: 'desktop-shell · 运维' },
            { id: 'dl-2', days: 0, title: '组件库提测', meta: '设计系统 v1' },
            { id: 'dl-3', days: 2, title: '回复设计评审意见', meta: '设计系统 v1' },
            { id: 'dl-4', days: 7, title: '主页迁移', meta: 'agent-tower' },
          ]}
        />
      </Specimen>

      <Specimen name="Leaderboard" title="排行榜" description="前三名序号加深；名次变化用小箭头，不用奖牌和彩色。">
        <Leaderboard
          entries={[
            { id: 'lb-1', name: 'Claude Code', avatar: <AgentAvatar agentType={AgentType.CLAUDE_CODE} />, meta: '486 次会话', value: '74%', change: 1 },
            { id: 'lb-2', name: 'Codex', avatar: <AgentAvatar agentType={AgentType.CODEX} />, meta: '312 次会话', value: '61%', change: -1 },
            { id: 'lb-3', name: 'Cursor Agent', avatar: <AgentAvatar agentType={AgentType.CURSOR_AGENT} />, meta: '97 次会话', value: '60%', change: 2 },
            { id: 'lb-4', name: 'Qwen Code', avatar: <AgentAvatar agentType={AgentType.QWEN_CODE} />, meta: '41 次会话', value: '50%' },
            { id: 'lb-5', name: 'Gemini CLI', avatar: <AgentAvatar agentType={AgentType.GEMINI_CLI} />, meta: '158 次会话', value: '47%', change: -2 },
          ]}
        />
        <Caption className="mt-2">一次通过审查的比例 · 10 月</Caption>
      </Specimen>

      <Specimen name="Bulletin" title="公告" description="日期块 + 标题 + 一两行正文；类型徽章只用 neutral，维护这类需要注意的才上色。">
        <Bulletin
          locale="zh-CN"
          items={[
            { id: 'bl-1', date: new Date(2026, 9, 14), title: '设计系统 v1 上线', body: '组件、设计规范与扩展规则都在 /design-system，新页面请从这里取组件。', badge: <Badge size="sm">公告</Badge> },
            { id: 'bl-2', date: new Date(2026, 9, 12), title: '隧道服务维护', body: '10 月 16 日 02:00–03:00 远程访问不可用，本地使用不受影响。', badge: <Badge size="sm" tone="warning">维护</Badge> },
            { id: 'bl-3', date: new Date(2026, 9, 9), title: 'v1.2：三档执行权限', body: '请求批准、自动同意（沙箱）、自动同意（完全访问）。', badge: <Badge size="sm">更新</Badge>, meta: '发布说明' },
          ]}
        />
      </Specimen>
    </ShowcaseSection>
  )
}

/* ── 表格 ─────────────────────────────────────────────────── */

const TASK_COLUMNS: DataColumn<DemoTask>[] = [
  {
    key: 'title',
    header: '任务',
    render: task => (
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-foreground">{task.title}</span>
        <ProjectTag name={task.project.name} color={task.project.color} />
      </span>
    ),
  },
  { key: 'status', header: '状态', width: '96px', render: task => <TaskStatusBadge status={task.status} /> },
  { key: 'agent', header: 'Agent', width: '136px', render: task => <AgentMark agentType={task.agent} size="sm" /> },
  { key: 'minutes', header: '耗时', width: '80px', numeric: true, sortable: true, render: task => (task.minutes ? `${task.minutes} 分钟` : '—') },
  {
    key: 'changes',
    header: '改动',
    width: '112px',
    numeric: true,
    sortable: true,
    sortValue: task => task.additions + task.deletions,
    render: task => <DiffStat additions={task.additions} deletions={task.deletions} />,
  },
  {
    key: 'updatedAt',
    header: '更新',
    width: '80px',
    numeric: true,
    sortable: true,
    render: task => <RelativeTime value={task.updatedAt} now={DEMO_NOW} className="text-xs" />,
  },
]

function DataTableDemo() {
  const [mode, setMode] = useState('data')
  const [selected, setSelected] = useState<string | null>(DEMO_TASKS[0].id)
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        aria-label="表格状态"
        size="sm"
        value={mode}
        onValueChange={setMode}
        options={[
          { value: 'data', label: '数据' },
          { value: 'loading', label: '首次加载' },
          { value: 'empty', label: '无结果' },
        ]}
      />
      <DataTable
        caption="最近的任务"
        columns={TASK_COLUMNS}
        rows={mode === 'empty' ? [] : DEMO_TASKS}
        rowKey={task => task.id}
        loading={mode === 'loading'}
        defaultSort={{ key: 'updatedAt', direction: 'desc' }}
        selectedKey={selected}
        onRowClick={task => setSelected(task.id)}
        empty={<EmptyState size="sm" icon={<Search />} title="没有匹配的任务" description="换个关键词，或清除筛选条件" />}
      />
    </div>
  )
}

export function TablesSection() {
  return (
    <ShowcaseSection
      id="tables"
      description="需要逐行比较、排序时用表格。表头 12px 灰字，行高 36px，数字列右对齐等宽；状态列用图标 + 文字。热力表用墨阶表示强弱，格内仍写数字。"
    >
      <Specimen
        name="DataTable"
        title="数据表"
        description="可排序的列悬停才显示排序箭头；可点击的行支持 Enter 打开，选中行浅灰底。"
        span={2}
        dos={['刷新时保留旧数据，骨架只用于首次加载', '空结果给出下一步：「换个关键词」']}
        donts={['斑马纹和竖线网格——行间细线就够了', '数字列左对齐']}
      >
        <DataTableDemo />
      </Specimen>

      <Specimen name="HeatTable" title="热力表" description="两个维度交叉的强弱：颜色帮助扫视，数字负责精确，打印和色弱同样可读。">
        <HeatTable
          aria-label="各项目按星期的任务数"
          corner="项目"
          rows={DEMO_PROJECTS.map(project => ({
            name: project.name,
            label: <><ProjectDot color={project.color} className="mr-1.5 inline-block align-[1px]" />{project.name}</>,
          }))}
          columns={WEEKDAY_LABELS}
          data={PROJECT_WEEKDAY}
        />
        <ScaleLegend className="mt-3" />
      </Specimen>

      <Specimen name="CalendarHeatmap" title="日历热力" description="每天的活跃度：周为列、星期为行，5 档墨阶；悬停看具体日期和数值。">
        <CalendarHeatmap
          aria-label="近 26 周每日会话数"
          start={ACTIVITY_START}
          values={ACTIVITY_VALUES}
          locale="zh-CN"
          describe={(date, value) => `${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${value} 次会话`}
        />
        <div className="mt-3 flex items-center justify-between">
          <Caption>近 26 周 · 共 {ACTIVITY_VALUES.reduce((sum, value) => sum + value, 0).toLocaleString('zh-CN')} 次会话</Caption>
          <ScaleLegend />
        </div>
      </Specimen>
    </ShowcaseSection>
  )
}

/* ── 流程与排期 ───────────────────────────────────────────── */

export function ScheduleSection() {
  return (
    <ShowcaseSection
      id="schedule"
      description="流程回答「走到哪一步了、卡在哪」，排期回答「什么时候、谁在做」。都用「今天」竖线做参照，受阻和逾期是唯一的彩色。"
    >
      <Specimen
        name="ProcessSteps"
        title="流程步骤"
        description="任务生命周期 / SOP：已完成的连线变黑，当前步骤黑框，受阻的步骤用红色——整条流程唯一需要处理的地方。"
        span={2}
      >
        <div className="flex flex-col gap-6">
          <ProcessSteps
            steps={[
              { id: 'p1', title: '创建任务', owner: '林夏', time: '09:12', status: 'done' },
              { id: 'p2', title: '准备工作区', owner: '自动', time: '09:13', status: 'done' },
              { id: 'p3', title: 'Agent 执行', owner: 'Claude Code', time: '48 分钟', status: 'done' },
              { id: 'p4', title: '代码审查', owner: '林夏', time: '进行中', status: 'current' },
              { id: 'p5', title: '合并', status: 'upcoming' },
            ]}
          />
          <ProcessSteps
            steps={[
              { id: 'q1', title: '创建任务', owner: '周远', time: '昨天', status: 'done' },
              { id: 'q2', title: '准备工作区', owner: '自动', time: '依赖安装失败', status: 'blocked' },
              { id: 'q3', title: 'Agent 执行', status: 'upcoming' },
              { id: 'q4', title: '代码审查', status: 'upcoming' },
              { id: 'q5', title: '合并', status: 'upcoming' },
            ]}
          />
        </div>
      </Specimen>

      <Specimen name="TopologyTree" title="拓扑树" description="TeamRun 团队结构：自上而下的层级，节点是小白卡，当前关注的节点加深描边。" span={2} canvas="chrome">
        <TopologyTree
          root={{
            id: 'lead',
            title: 'Lead',
            subtitle: 'Claude Code · 拆解与汇总',
            icon: <AgentLogo agentType={AgentType.CLAUDE_CODE} />,
            status: <LiveDot tone="info" label="运行中" />,
            children: [
              { id: 'planner', title: 'Planner', subtitle: 'Codex', icon: <AgentLogo agentType={AgentType.CODEX} /> },
              {
                id: 'coder',
                title: 'Coder',
                subtitle: '2 个实例',
                icon: <Code2 />,
                active: true,
                children: [
                  { id: 'coder-a', title: 'Coder A', subtitle: '组件库', icon: <AgentLogo agentType={AgentType.CLAUDE_CODE} />, status: <LiveDot tone="info" label="运行中" /> },
                  { id: 'coder-b', title: 'Coder B', subtitle: '展示页', icon: <AgentLogo agentType={AgentType.GEMINI_CLI} />, status: <LiveDot tone="info" label="运行中" /> },
                ],
              },
              { id: 'reviewer', title: 'Reviewer', subtitle: 'Codex · 等待中', icon: <Bot /> },
            ],
          }}
        />
      </Specimen>

      <Specimen name="GanttChart" title="甘特图" description="横条是起止，墨色部分是已完成的比例，斜纹是剩余；竖线是今天。条外写负责人，不靠颜色区分人。" span={2}>
        <GanttChart aria-label="v1.3 里程碑排期" tasks={GANTT_TASKS} start={GANTT_START} days={28} today={9} locale="zh-CN" />
      </Specimen>

      <Specimen name="MonthCalendar" title="月历" description="一个月的事件：今天是黑底日期；只有带状态含义的事件（到期、维护）才上色，超出的折叠成「+N」。" span={2}>
        <MonthCalendar year={2026} month={9} today="2026-10-14" events={CALENDAR_EVENTS} locale="zh-CN" />
      </Specimen>
    </ShowcaseSection>
  )
}

/* ── 人与内容 ─────────────────────────────────────────────── */

const PEOPLE = [{ name: '林夏' }, { name: '周远' }, { name: '陈默' }, { name: 'Alex Kim' }, { name: '王若' }, { name: 'Sam Lee' }]

const DIFF_SNIPPET = `export function navRowClassName(active: boolean, className?: string) {
  return cn(
    'flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-sm',
    active
      ? 'bg-background shadow-raised ring-1 ring-border/80'
      : 'text-foreground/80 hover:bg-accent',
    className,
  )
}`

export function PeopleSection() {
  return (
    <ShowcaseSection
      id="people"
      description="人用单色头像 + 缩写，不给每个人分配颜色；Agent 用官方 logo。内容类组件（文件、提交、代码、终端）都是等宽字，路径从左截断，复制按钮在右上。"
    >
      <Specimen
        name="Avatar · AvatarGroup"
        title="头像"
        description="圆形是人，方形是项目 / 机器人。叠放时白描边，超出收成「+N」。"
        dos={['有头像图片就用图片（预设或上传），没有或加载失败时退回缩写']}
        donts={['色块头像（自选底色 + 白字）：颜色只留给状态']}
      >
        <div className="flex flex-col gap-5">
          <DemoRow label="尺寸">
            <Avatar name="林夏" size="xs" />
            <Avatar name="林夏" size="sm" />
            <Avatar name="林夏" size="md" />
            <Avatar name="林夏" size="lg" />
            <Caption className="ml-1">20 · 24 · 32 · 40</Caption>
          </DemoRow>
          <DemoRow label="缩写与形状">
            <Avatar name="周远" size="md" />
            <Avatar name="Alex Kim" size="md" />
            <Avatar name="docs-site" size="md" shape="square" />
            <Avatar name="Agent Tower" src={logoUrl} size="md" shape="square" />
          </DemoRow>
          <DemoRow label="叠放">
            <AvatarGroup people={PEOPLE} max={4} />
            <span className="text-xs text-muted-foreground">6 人参与</span>
          </DemoRow>
        </div>
        <Caption className="mt-4">中文取名字最后两个字，24px 及以下只取一个字；英文取前两个单词的首字母。</Caption>
      </Specimen>

      <Specimen name="MessageBubble" title="对话" description="用户消息是右侧灰气泡（右上角收尖）；Agent 回复不加气泡，长回复、代码、表格才有足够宽度。">
        <div className="flex flex-col gap-4">
          <MessageBubble from="user" time="15:02">
            把左侧任务面板的行高改成 32px，元信息悬停时收起，参考 <FileChip path="src/components/task/TaskList.tsx" />
          </MessageBubble>
          <MessageBubble
            from="agent"
            author="Claude Code"
            time="15:04"
            avatar={<AgentAvatar agentType={AgentType.CLAUDE_CODE} />}
          >
            已改好：行高统一走 <code className="rounded bg-foreground/[0.05] px-1 font-mono text-xs">navRowClassName</code>，元信息用 grid 1fr → 0fr 收起，宽度精确跟随内容。改动了 3 个文件，测试已通过，用法写进了<TextLink href="#people">设计系统 README</TextLink>。
          </MessageBubble>
        </div>
      </Specimen>

      <Specimen name="FileRow · FileChip" title="文件" description="状态字母（A/M/D/R）· 文件名 · 灰色目录（从左截断）· 增删统计。">
        <div className="-mx-2 flex flex-col">
          <FileRow path="packages/web/src/design-system/navigation/nav-row.tsx" status="A" additions={64} active />
          <FileRow path="packages/web/src/index.css" status="M" additions={60} deletions={2} />
          <FileRow path="packages/web/src/components/task/TaskGroup.tsx" status="M" additions={12} deletions={31} />
          <FileRow path="packages/web/src/components/task/legacy-row.tsx" status="D" deletions={88} />
          <FileRow path="docs/design/tokens.md" status="R" additions={3} deletions={3} />
        </div>
        <div className="mt-4 flex flex-wrap gap-1.5">
          <FileChip path="src/index.css" />
          <FileChip path="design/hero.png" />
          <FileChip path="README.md" />
        </div>
      </Specimen>

      <Specimen name="CommitItem" title="提交" description="提交信息一行 · 作者与时间 · 等宽短哈希（可复制）。">
        <div className="flex flex-col divide-y divide-border/50">
          <CommitItem message="feat(web): 重塑左侧任务面板样式与交互" hash="8721b9c4e2a1f0d93b7c" author="Claude Code" time={<RelativeTime value={DEMO_NOW - 4 * MINUTE} now={DEMO_NOW} />} additions={412} deletions={187} />
          <CommitItem message="feat: 展示任务所属项目名称并优化悬停动效" hash="bb1ecaa07d5e33f1a2c9" author="林夏" time={<RelativeTime value={DEMO_NOW - 26 * 60 * MINUTE} now={DEMO_NOW} />} additions={96} deletions={41} />
          <CommitItem message="fix: 修复 Claude 会话自动结束及停止时进程树清理超时" hash="7503b04aa81c2e9f6d10" author="Codex" time={<RelativeTime value={DEMO_NOW - 3 * 24 * 60 * MINUTE} now={DEMO_NOW} />} />
        </div>
      </Specimen>

      <Specimen name="CodeBlock" title="代码块" description="浅灰底等宽 12px、行高 20px；长行横向滚动，不自动折行。">
        <CodeBlock title="design-system/navigation/nav-row-styles.ts" code={DIFF_SNIPPET} lineNumbers />
      </Specimen>

      <Specimen name="TerminalBlock" title="终端输出" description="全站唯一常驻的深色面，配色与 xterm 主题一致，像「窗口中的窗口」。">
        <TerminalBlock
          title="pnpm --filter web build"
          status={<span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-terminal-green" />退出码 0</span>}
          lines={[
            { kind: 'command', text: 'pnpm --filter web build' },
            { kind: 'muted', text: '> tsc -b && vite build' },
            { text: 'vite building for production...' },
            { kind: 'success', text: '✓ 2481 modules transformed.' },
            { kind: 'warning', text: '(!) Some chunks are larger than 500 kB after minification.' },
            { kind: 'success', text: '✓ built in 14.62s' },
          ]}
        />
      </Specimen>

      <Specimen name="PromptBlock" title="可复制的指令" description="「把这句话发给你的 Agent」：正文墨色，右上角带文字的复制按钮。" span={2}>
        <PromptBlock text="请阅读 packages/web/src/design-system/README.md，新页面只从 @/design-system 引入组件；需要新组件时先在展示页加样张，再写进组件库。" />
      </Specimen>
    </ShowcaseSection>
  )
}
