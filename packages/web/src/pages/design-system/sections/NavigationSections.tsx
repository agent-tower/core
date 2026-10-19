import { useState } from 'react'
import { AgentType, TaskPriority } from '@agent-tower/shared'
import { Bell, Bot, Folder, GitMerge, Layers, MoreHorizontal, Settings, SquarePen, SquareTerminal } from 'lucide-react'
import { STATUS_ORDER } from '@/components/task/status-styles'
import { UITaskStatus } from '@/components/task/types'
import {
  AgentMark,
  Breadcrumb,
  BreadcrumbItem,
  BranchTag,
  Button,
  CountBadge,
  DiffStat,
  IconButton,
  KbdGroup,
  NavGroup,
  NavRow,
  PriorityTag,
  ProjectDot,
  ProjectTag,
  PromptBlock,
  RelativeTime,
  Stepper,
  StepList,
  TaskRow,
  TaskStatusBadge,
  TaskStatusGroup,
} from '@/design-system'
import { DEMO_NOW, DEMO_PROJECTS, DEMO_TASKS } from '../demo-data'
import { Caption, Code, DemoRow, ShowcaseSection, Specimen } from '../showcase'

/* ── 导航 ─────────────────────────────────────────────────── */

export function NavigationSection() {
  const [activeProject, setActiveProject] = useState<string>(DEMO_PROJECTS[0].name)
  const [step, setStep] = useState(2)
  return (
    <ShowcaseSection
      id="navigation"
      description="导航只在灰色外框里：侧栏行、分组、面包屑。选中行是浮起的白卡，和右侧内容岛是同一种材质。"
    >
      <Specimen
        name="NavRow · NavGroup"
        title="侧栏行与分组"
        description="行高 32px（触屏 40px），字号 14px（触屏 15px），图标 16px；分组标题与行同字号，用灰色常规体和行区分，后跟折叠箭头和计数。"
        canvas="chrome"
        dos={['右侧元信息只放计数、时间、快捷键，并保持紧凑']}
        donts={['在侧栏行里放按钮组——行尾操作用悬停才出现的图标按钮或右键菜单']}
      >
        <div className="max-w-[300px]">
          <NavRow icon={<SquarePen />} label="新建任务" meta={<KbdGroup keys={['⌘', 'N']} />} className="mb-2" />
          <NavGroup title="项目" count={DEMO_PROJECTS.length}>
            <NavRow
              icon={<Layers />}
              label="全部项目"
              meta="34"
              active={activeProject === 'all'}
              onClick={() => setActiveProject('all')}
            />
            {DEMO_PROJECTS.map((project, index) => (
              <NavRow
                key={project.name}
                icon={<ProjectDot color={project.color} className="mx-1" />}
                label={project.name}
                meta={[24, 7, 3, 0][index]}
                active={activeProject === project.name}
                onClick={() => setActiveProject(project.name)}
              />
            ))}
          </NavGroup>
          <NavGroup title="设置" defaultOpen={false}>
            <NavRow icon={<Settings />} label="通用" />
            <NavRow icon={<Bot />} label="Agent 与 Provider" />
            <NavRow icon={<Bell />} label="通知" />
          </NavGroup>
        </div>
      </Specimen>

      <Specimen name="StepList" title="步骤清单" description="带内容的操作指引：命令、Prompt、按钮放在步骤下方，竖线串起各步。">
        <StepList
          steps={[
            { title: '安装 Agent Tower', description: '全局安装后即可启动本地服务（默认端口 12580）。', status: 'done' },
            {
              title: '把 MCP 服务告诉你的 Agent',
              description: '复制下面这句话发给 Agent，它会自己完成注册。',
              status: 'current',
              content: <PromptBlock text="请运行 claude mcp add agent-tower -- agent-tower-mcp，然后列出 agent-tower 提供的工具确认连接成功。" />,
            },
            { title: '在对话里创建任务', description: '「在 agent-tower 项目里新建一个任务：修复终端滚动」' },
          ]}
        />
      </Specimen>
      <Specimen name="Stepper" title="步骤条" description="3–5 步的线性流程：已完成实心对勾、当前黑环、未开始灰环，连线随进度变黑。横向需要整行宽度，窄处改用步骤清单。" span={2}>
        <Stepper
          current={step}
          steps={[
            { title: '安装 CLI', description: 'claude / codex' },
            { title: '登录', description: '官方账号或 Provider' },
            { title: '添加项目', description: '选择 Git 仓库' },
            { title: '第一个任务' },
          ]}
        />
        <div className="mt-4 flex gap-1.5">
          <Button size="xs" variant="ghost" disabled={step === 0} onClick={() => setStep(current => Math.max(0, current - 1))}>上一步</Button>
          <Button size="xs" disabled={step === 4} onClick={() => setStep(current => Math.min(4, current + 1))}>下一步</Button>
        </div>
      </Specimen>

      <Specimen name="Breadcrumb" title="面包屑" description="告诉用户「我在哪」，最后一级可下拉切换同级对象；不超过 3 级。" span={2} canvas="chrome">
        <div className="flex flex-wrap items-center gap-x-16 gap-y-4">
          <Breadcrumb>
            <BreadcrumbItem>Agent Tower</BreadcrumbItem>
            <BreadcrumbItem icon={<Folder />} menu current>agent-tower</BreadcrumbItem>
          </Breadcrumb>
          <Breadcrumb>
            <BreadcrumbItem icon={<Folder />}>agent-tower</BreadcrumbItem>
            <BreadcrumbItem>任务</BreadcrumbItem>
            <BreadcrumbItem current>重塑左侧任务面板样式与交互</BreadcrumbItem>
          </Breadcrumb>
        </div>
      </Specimen>

    </ShowcaseSection>
  )
}

/* ── 业务组件 ─────────────────────────────────────────────── */

export function BusinessSection() {
  const [selectedTask, setSelectedTask] = useState(DEMO_TASKS[0].id)
  const groups = STATUS_ORDER.map(status => ({ status, tasks: DEMO_TASKS.filter(task => task.status === status) }))
  const headline = DEMO_TASKS[0]
  return (
    <ShowcaseSection
      id="business"
      description="Agent Tower 专属组件：任务、项目、分支、Agent。状态的颜色和图标只来自 components/task/status-styles 一处映射，这里只负责排版。"
    >
      <Specimen
        name="TaskStatusGroup · TaskRow"
        title="任务分组与任务行"
        description="分组标题吸顶，状态图标每组只出现一次；任务行不放状态图标，宽度全部留给标题。标题按需要你介入的程度分级：待审查加粗、进行中淡扫光、已结束降灰。悬停或键盘聚焦时元信息收起；侧栏窄于 22rem 时项目标签自动隐藏。"
        canvas="chrome"
        dos={['普通优先级（P2）不显示：只有偏离常态才值得占位', '标题完整内容放在 title 里']}
        donts={['在任务行行首再放状态图标——状态由分组标题表达', '在任务行里加第三种元信息——放进详情页']}
      >
        {/* 限高滚动，演示分组标题吸顶；scroll-pt-8 让出标题高度，键盘聚焦的行不会被盖住 */}
        <div className="@container max-h-[300px] max-w-[400px] overflow-y-auto scroll-pt-8 scrollbar-app-thin">
          {groups.filter(group => group.tasks.length > 0).map(group => (
            <TaskStatusGroup
              key={group.status}
              status={group.status}
              count={group.tasks.length}
              defaultOpen={group.status !== UITaskStatus.Cancelled}
            >
              {group.tasks.map(task => (
                <TaskRow
                  key={task.id}
                  title={task.title}
                  status={task.status}
                  priority={task.priority}
                  project={task.project}
                  updatedAt={task.updatedAt}
                  now={DEMO_NOW}
                  active={selectedTask === task.id}
                  onClick={() => setSelectedTask(task.id)}
                />
              ))}
            </TaskStatusGroup>
          ))}
        </div>
        <Caption className="mt-3">列表限高 300px，滚动看分组标题吸顶。</Caption>
      </Specimen>

      <Specimen name="Task header" title="任务详情头" description="内容岛顶部：标题一行，状态与元信息一行，操作靠右。主操作只有一个。">
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <h3 className="min-w-0 text-base font-semibold leading-6 text-foreground">{headline.title}</h3>
            <div className="flex shrink-0 items-center gap-1">
              <IconButton size="sm" label="打开终端"><SquareTerminal /></IconButton>
              <IconButton size="sm" label="更多操作"><MoreHorizontal /></IconButton>
              <Button size="sm" variant="primary"><GitMerge />合并</Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <TaskStatusBadge status={headline.status} />
            <PriorityTag priority={headline.priority} showLabel />
            <ProjectTag name={headline.project.name} color={headline.project.color} shorten={false} />
            <BranchTag name="feat/sidebar-compact-rows" className="max-w-[180px]" />
            <AgentMark agentType={AgentType.CLAUDE_CODE} size="sm" />
            <DiffStat additions={headline.additions} deletions={headline.deletions} bar />
            <RelativeTime value={headline.updatedAt} now={DEMO_NOW} className="text-xs" />
          </div>
        </div>
      </Specimen>

      <Specimen name="TaskStatus" title="任务状态" description="五种状态，lucide 线性图标 + 文字成对出现，与侧栏菜单同一套笔触；图标不加动画——「正在运行」由任务标题的淡扫光表达。">
        <div className="flex flex-col gap-2.5">
          {STATUS_ORDER.map(status => (
            <div key={status} className="flex items-center gap-4">
              <span className="w-24"><TaskStatusBadge status={status} /></span>
              <Code>{status}</Code>
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen name="Meta" title="元信息原子" description="任务行、详情头、表格共用的小部件：都很紧凑，都能截断，完整内容在悬停提示里。">
        <div className="flex flex-col gap-3">
          <DemoRow label="优先级">
            <PriorityTag priority={TaskPriority.URGENT} />
            <PriorityTag priority={TaskPriority.HIGH} />
            <PriorityTag priority={TaskPriority.NORMAL} />
            <PriorityTag priority={TaskPriority.LOW} />
            <PriorityTag priority={TaskPriority.URGENT} showLabel />
          </DemoRow>
          <DemoRow label="项目">
            {DEMO_PROJECTS.map(project => <ProjectTag key={project.name} name={project.name} color={project.color} />)}
          </DemoRow>
          <DemoRow label="分支">
            <BranchTag name="main" />
            <BranchTag name="feat/design-system-component-library" className="max-w-[200px]" />
          </DemoRow>
          <DemoRow label="改动">
            <DiffStat additions={412} deletions={187} />
            <DiffStat additions={58} deletions={0} bar />
            <DiffStat additions={0} deletions={0} />
          </DemoRow>
          <DemoRow label="时间">
            <RelativeTime value={DEMO_NOW - 20_000} now={DEMO_NOW} className="text-xs" />
            <RelativeTime value={DEMO_NOW - 12 * 60_000} now={DEMO_NOW} className="text-xs" />
            <RelativeTime value={DEMO_NOW - 5 * 3_600_000} now={DEMO_NOW} className="text-xs" />
            <RelativeTime value={DEMO_NOW - 3 * 86_400_000} now={DEMO_NOW} className="text-xs" />
            <RelativeTime value={DEMO_NOW - 40 * 86_400_000} now={DEMO_NOW} className="text-xs" />
          </DemoRow>
          <DemoRow label="计数">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">待审查<CountBadge count={3} tone="warning" /></span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">已完成<CountBadge count={128} /></span>
          </DemoRow>
        </div>
        <Caption className="mt-3">相对时间每 30 秒刷新一次（共享时钟），一周以上显示日期。</Caption>
      </Specimen>
    </ShowcaseSection>
  )
}
