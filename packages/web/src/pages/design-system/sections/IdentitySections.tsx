import { AgentType } from '@agent-tower/shared'
import { useState } from 'react'
import { AgentLogo } from '@/components/agent/AgentLogo'
import { CharcoalBreathe } from '@/components/loading/LoadingAnimations'
import {
  AgentMark,
  Button,
  ChipSelect,
  Icon,
  ICON_GROUPS,
  ICON_SIZE,
  icons,
  LiveDot,
  MOTION,
  Ring,
  Spinner,
  ThinkingText,
  TONE_MARK,
  Track,
  usePrefersReducedMotion,
  WorkingDots,
  type IconSize,
} from '@/design-system'
import { AGENT_META_BY_TYPE } from '@/lib/agent-meta'
import { cn } from '@/lib/utils'
import { Caption, Code, DemoRow, ShowcaseSection, Specimen } from '../showcase'

/* ── 图标 ─────────────────────────────────────────────────── */

const SIZE_USAGE: Record<IconSize, string> = {
  xs: '折叠箭头、行内小标记',
  sm: '胶囊、菜单项、按钮 sm',
  md: '列表行、按钮（默认）',
  lg: '工具栏',
  xl: '强调、标题旁',
}

export function IconsSection() {
  const total = Object.keys(icons).length
  return (
    <ShowcaseSection
      id="icons"
      description={`lucide 线性图标，按语义注册，共 ${total} 个。业务代码写 <Icon name="delete" />，不直接引入图标组件——换一个图标只改注册表一处。`}
    >
      <Specimen
        name="Icon"
        title="语义图标"
        span={2}
        dos={['按含义取图标（delete、branch），同一含义全站只用一个图标', '图标独立承载含义时提供 aria-label 或 Tooltip']}
        donts={['同一个动作在不同页面用不同图标', '给普通图标上色：图标颜色跟随文字，只有状态图标有颜色']}
      >
        <div className="space-y-5">
          {ICON_GROUPS.map(group => (
            <div key={group.title}>
              <div className="mb-2 flex items-baseline gap-2 text-xs font-medium text-foreground">
                {group.title}
                <span className="text-[11px] font-normal tabular-nums text-muted-foreground">{group.names.length}</span>
              </div>
              <div className="grid grid-cols-4 gap-1 sm:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 2xl:grid-cols-11">
                {group.names.map(name => (
                  <div
                    key={name}
                    title={name}
                    className="flex min-w-0 flex-col items-center gap-1.5 rounded-lg px-1 py-3 text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Icon name={name} />
                    <span className="max-w-full truncate font-mono text-[10px] text-muted-foreground">{name}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen name="Size" title="尺寸与描边" description="五档尺寸；24px 以上（空状态插图）描边降到 1.5，避免显得笨重。">
        <div className="flex flex-col gap-3">
          {(Object.keys(ICON_SIZE) as IconSize[]).map(size => (
            <div key={size} className="flex items-center gap-3">
              <span className="flex w-8 shrink-0 justify-center text-foreground"><Icon name="agent" size={size} /></span>
              <span className="w-14 shrink-0 font-mono text-[11px] text-foreground/80">{size} · {ICON_SIZE[size]}</span>
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">{SIZE_USAGE[size]}</span>
            </div>
          ))}
          <div className="flex items-center gap-3">
            <span className="flex w-8 shrink-0 justify-center text-muted-foreground/60"><Icon name="inbox" size={32} /></span>
            <span className="w-14 shrink-0 font-mono text-[11px] text-foreground/80">32 · 1.5</span>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">空状态插图（浅灰、细描边）</span>
          </div>
        </div>
      </Specimen>

      <Specimen name="Tint" title="图标颜色" description="默认是说明灰，悬停跟随文字变深；状态图标是唯一有颜色的图标。">
        <div className="flex flex-col gap-3">
          <DemoRow label="默认">
            <span className="flex items-center gap-2 text-sm text-foreground/80"><Icon name="project" className="text-muted-foreground" />agent-tower</span>
          </DemoRow>
          <DemoRow label="悬停 / 选中">
            <span className="flex items-center gap-2 text-sm text-foreground"><Icon name="project" />agent-tower</span>
          </DemoRow>
          <DemoRow label="状态">
            <Icon name="success" className={TONE_MARK.success} aria-label="成功" />
            <Icon name="warning" className={TONE_MARK.warning} aria-label="警告" />
            <Icon name="error" className={TONE_MARK.danger} aria-label="错误" />
            <Icon name="info" className={TONE_MARK.info} aria-label="信息" />
          </DemoRow>
          <DemoRow label="禁用">
            <span className="flex items-center gap-2 text-sm text-foreground/40"><Icon name="lock" />只读项目</span>
          </DemoRow>
        </div>
      </Specimen>
    </ShowcaseSection>
  )
}

/* ── Agent 标志 ───────────────────────────────────────────── */

export function AgentsSection() {
  const agents = Object.values(AGENT_META_BY_TYPE)
  return (
    <ShowcaseSection
      id="agents"
      description="Agent 靠官方 logo 区分身份，不分配颜色。没有 logo 或加载失败时退回通用芯片图标，名称照常显示。"
    >
      <Specimen name="AgentLogo" title="标志墙" span={2} donts={['给 Agent 分配主题色，或把 logo 重新着色']}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
          {agents.map(meta => (
            <div key={meta.agentType} className="flex min-w-0 flex-col items-center gap-2 rounded-lg border border-border/60 px-2 py-4">
              <AgentLogo agentType={meta.agentType} className="size-8" />
              <span className="max-w-full truncate text-xs font-medium text-foreground">{meta.label}</span>
              <span className="max-w-full truncate font-mono text-[10px] text-muted-foreground">{meta.logoSrc ? meta.agentType : '无 logo · 回退'}</span>
            </div>
          ))}
          <div className="flex min-w-0 flex-col items-center gap-2 rounded-lg border border-dashed border-border px-2 py-4">
            <AgentLogo agentType={null} className="size-8" />
            <span className="text-xs font-medium text-foreground">未知 Agent</span>
            <span className="font-mono text-[10px] text-muted-foreground">fallback</span>
          </div>
        </div>
      </Specimen>

      <Specimen name="AgentMark" title="标识 + 名称" description="三档尺寸；只放 logo 时名称进入读屏文本和悬停提示。">
        <div className="flex flex-col gap-3">
          <DemoRow label="sm · 14">
            <AgentMark agentType={AgentType.CLAUDE_CODE} size="sm" />
            <AgentMark agentType={AgentType.CODEX} size="sm" />
          </DemoRow>
          <DemoRow label="md · 16">
            <AgentMark agentType={AgentType.CLAUDE_CODE} />
            <AgentMark agentType={AgentType.GEMINI_CLI} />
          </DemoRow>
          <DemoRow label="lg · 20">
            <AgentMark agentType={AgentType.CURSOR_AGENT} size="lg" />
          </DemoRow>
          <DemoRow label="仅 logo">
            <AgentMark agentType={AgentType.CLAUDE_CODE} showLabel={false} />
            <AgentMark agentType={AgentType.CODEX} showLabel={false} />
            <AgentMark agentType={AgentType.QWEN_CODE} showLabel={false} />
          </DemoRow>
        </div>
      </Specimen>

      <Specimen name="In context" title="在界面里" description="输入卡下方的胶囊选择器：平时是一行灰字，悬停才浮出底色。">
        <div className="flex flex-wrap items-center gap-1">
          <ChipSelect
            aria-label="Agent"
            defaultValue={AgentType.CLAUDE_CODE}
            menuWidth="md"
            options={agents.slice(0, 6).map(meta => ({
              value: meta.agentType,
              label: meta.label,
              icon: <AgentLogo agentType={meta.agentType} className="size-3.5" />,
            }))}
          />
          <ChipSelect
            aria-label="工作区"
            defaultValue="worktree"
            menuWidth="lg"
            options={[
              { value: 'worktree', label: '新建工作树', description: '在独立分支上工作，不影响主目录' },
              { value: 'local', label: '本地目录', description: '直接修改项目目录' },
            ]}
          />
        </div>
        <Caption className="mt-3">点开试试：菜单与选择框同材质，选中项右侧对勾，可带一行说明。</Caption>
      </Specimen>
    </ShowcaseSection>
  )
}

/* ── 动效 ─────────────────────────────────────────────────── */

const EASINGS = [
  { name: 'ease-enter', curve: MOTION.easeEnter, points: [0.16, 1, 0.3, 1], usage: '进入、展开、数值增长' },
  { name: 'ease-move', curve: MOTION.easeMove, points: [0.2, 0, 0, 1], usage: '位移、拖拽归位、面板滑动' },
  { name: 'linear', curve: 'linear', points: [0, 0, 1, 1], usage: '只用于循环：转圈、扫光' },
]

const DURATIONS = [
  { ms: 100, usage: '悬停变色' },
  { ms: 150, usage: '开关、复选、分段切换、按钮' },
  { ms: 200, usage: '折叠展开、元信息收起' },
  { ms: 250, usage: '列表新增行（taskSlideIn）' },
  { ms: 500, usage: '首屏标题上浮（fadeInUp）、进度增长' },
  { ms: 700, usage: '环形进度' },
]

function CurveGlyph({ points }: { points: number[] }) {
  const [x1, y1, x2, y2] = points
  const size = 36
  return (
    <svg viewBox={`-2 -2 ${size + 4} ${size + 4}`} className="size-10 shrink-0" aria-hidden="true">
      <rect x="0" y="0" width={size} height={size} rx="3" fill="none" stroke="var(--viz-grid)" />
      <path
        d={`M0 ${size} C ${x1 * size} ${size - y1 * size} ${x2 * size} ${size - y2 * size} ${size} 0`}
        fill="none"
        stroke="var(--viz-6)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function EasingDemo() {
  const reduced = usePrefersReducedMotion()
  const [forward, setForward] = useState(false)
  return (
    <div className="flex flex-col gap-3">
      {EASINGS.map(easing => (
        <div key={easing.name} className="flex items-center gap-3">
          <CurveGlyph points={easing.points} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <Code>{easing.name}</Code>
              <span className="truncate text-[11px] text-muted-foreground">{easing.usage}</span>
            </div>
            <div className="relative mt-1.5 h-5 rounded-full bg-foreground/[0.05]">
              <span
                className="absolute top-0.5 size-4 rounded-full bg-primary shadow-raised"
                style={{
                  left: forward ? 'calc(100% - 18px)' : '2px',
                  transition: reduced ? 'none' : `left 600ms ${easing.curve}`,
                }}
              />
            </div>
          </div>
        </div>
      ))}
      <div>
        <Button size="sm" onClick={() => setForward(current => !current)}>播放</Button>
      </div>
    </div>
  )
}

const NEW_TASK_TITLES = ['接入飞书通知', '优化终端滚动性能', '补充 MCP 工具文档', '修复隧道断线重连', '项目设置支持快捷命令']

function EnterDemo() {
  const [heroRun, setHeroRun] = useState(0)
  const [rows, setRows] = useState([
    { id: 0, title: '重塑左侧任务面板样式与交互' },
    { id: -1, title: '修复会话自动结束' },
  ])
  const addRow = () => {
    setRows(current => {
      const id = (current[0]?.id ?? 0) + 1
      return [{ id, title: NEW_TASK_TITLES[(id - 1) % NEW_TASK_TITLES.length] }, ...current].slice(0, 4)
    })
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <div className="flex h-40 flex-col items-center justify-center rounded-lg bg-sidebar">
          <div key={heroRun} className="flex animate-[fadeInUp_0.5s_cubic-bezier(0.16,1,0.3,1)] flex-col items-center">
            <p className="text-[17px] font-medium tracking-tight text-foreground">你需要做点什么？</p>
            <div className="mt-3 h-10 w-52 rounded-xl border border-border bg-background shadow-raised" />
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <Caption>首屏 fadeInUp · 500ms · 上浮 10px</Caption>
          <Button size="xs" variant="ghost" onClick={() => setHeroRun(run => run + 1)}>重播</Button>
        </div>
      </div>
      <div>
        <div className="h-40 overflow-hidden rounded-lg bg-sidebar p-1.5">
          {rows.map(row => (
            <div key={row.id} className="animate-task-enter flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-foreground/80">
              <span className="size-3.5 shrink-0 rounded-full ring-[1.5px] ring-inset ring-foreground/30" />
              <span className="truncate">{row.title}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <Caption>新增行 taskSlideIn · 250ms · 下落 6px</Caption>
          <Button size="xs" variant="ghost" onClick={addRow}>新增任务</Button>
        </div>
      </div>
    </div>
  )
}

function CelebrateDemo() {
  const [done, setDone] = useState(false)
  const [run, setRun] = useState(0)
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        aria-pressed={done}
        aria-label={done ? '标记为未完成' : '完成任务'}
        onClick={() => {
          setDone(current => !current)
          setRun(current => current + 1)
        }}
        className="relative flex size-10 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {done && <span key={`burst-${run}`} aria-hidden="true" className="ds-ring-burst absolute inset-1 rounded-full ring-2 ring-success" />}
        <span
          className={cn(
            'flex size-6 items-center justify-center rounded-full transition-colors duration-150',
            done ? 'bg-success text-white' : 'ring-[1.5px] ring-inset ring-foreground/30 hover:ring-foreground/50',
          )}
        >
          {done && (
            <svg key={`check-${run}`} viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
              <path className="ds-check-draw" d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
      </button>
      <div className="min-w-0">
        <div className={cn('truncate text-sm transition-colors duration-150', done ? 'text-muted-foreground line-through' : 'text-foreground')}>修复会话自动结束</div>
        <div className="text-[11px] text-muted-foreground">点圆圈完成：对勾描绘 + 一次光环</div>
      </div>
    </div>
  )
}

function MomentumDemo() {
  const [value, setValue] = useState(0.35)
  return (
    <div className="flex items-center gap-5">
      <Ring value={value} size={72} expected={0.6} aria-label="迭代进度" />
      <div className="min-w-0 flex-1 space-y-2.5">
        <Track value={value} expected={0.6} size="md" aria-label="迭代进度" />
        <div className="flex items-center gap-1.5">
          <Button size="xs" onClick={() => setValue(current => Math.min(1, Math.round((current + 0.15) * 100) / 100))}>推进 15%</Button>
          <Button size="xs" variant="ghost" onClick={() => setValue(0.35)}>重置</Button>
        </div>
      </div>
    </div>
  )
}

export function MotionSection() {
  return (
    <ShowcaseSection
      id="motion"
      description="动效只做三件事：交代新内容从哪来、确认状态变了、表明事情还在进行。所有循环动画都有减少动态效果的降级。"
    >
      <Specimen
        name="Easing"
        title="缓动"
        description="界面过渡只用两条曲线，循环才用 linear。"
        dos={['进入用 ease-enter，位移用 ease-move']}
        donts={['弹跳、回弹曲线——工具界面不需要「俏皮」']}
      >
        <EasingDemo />
      </Specimen>

      <Specimen name="Duration" title="时长" description="越小的变化越快；界面过渡不超过 500ms。">
        <div className="flex flex-col gap-2">
          {DURATIONS.map(duration => (
            <div key={duration.ms} className="flex items-center gap-3">
              <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-foreground/80">{duration.ms}ms</span>
              <span className="w-28 shrink-0">
                <span className="block h-1.5 rounded-full bg-viz-6" style={{ width: `${(duration.ms / 700) * 100}%` }} />
              </span>
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">{duration.usage}</span>
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen name="Enter" title="进入" description="新内容从它「来的方向」出现：首屏向上浮起，列表新行从上方落下。" span={2}>
        <EnterDemo />
      </Specimen>

      <Specimen name="Celebrate" title="完成时刻" description="只在用户亲手完成一件事时出现一次，不循环、不放礼花。">
        <CelebrateDemo />
      </Specimen>

      <Specimen name="Momentum" title="进度增长" description="数值变化时从旧值长到新值（500–700ms），竖线是此刻应到的位置。">
        <MomentumDemo />
      </Specimen>

      <Specimen
        name="Live"
        title="进行中"
        description="循环动画只给「正在发生」的事。"
        donts={['给静止的内容加呼吸、漂浮等装饰性循环']}
      >
        <div className="flex flex-col gap-3">
          <DemoRow label="在线 / 运行">
            <span className="flex items-center gap-2 text-[13px] text-foreground/80"><LiveDot label="在线" />隧道已连接</span>
            <span className="flex items-center gap-2 text-[13px] text-foreground/80"><LiveDot tone="info" />Claude Code 运行中</span>
          </DemoRow>
          <DemoRow label="思考">
            <ThinkingText text="正在思考" className="text-[13px]" />
          </DemoRow>
          <DemoRow label="处理中">
            <span className="text-[13px] text-muted-foreground">正在创建工作区<WorkingDots /></span>
          </DemoRow>
          <DemoRow label="短等待">
            <Spinner label="正在读取文件" />
          </DemoRow>
        </div>
      </Specimen>

      <Specimen name="Brand" title="品牌加载" description="首屏加载（FullscreenLoading）：Charcoal 标志缓慢呼吸，2s 一个周期。">
        <div className="flex h-28 items-center justify-center rounded-lg bg-background">
          <CharcoalBreathe />
        </div>
      </Specimen>
    </ShowcaseSection>
  )
}
