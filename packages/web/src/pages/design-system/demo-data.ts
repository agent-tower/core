/**
 * 设计系统展示页的演示数据。
 *
 * 全部确定性生成：固定「今天」与随机种子，截图、对比和测试每次都得到同一画面。
 */
import { AgentType, TaskPriority } from '@agent-tower/shared'
import { UITaskStatus } from '@/components/task/types'
import { addDays } from '@/design-system'

/** 演示用「今天」：2026-10-14（周三）15:30 */
export const DEMO_TODAY = new Date(2026, 9, 14)
export const DEMO_NOW = new Date(2026, 9, 14, 15, 30).getTime()

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** mulberry32：32 位种子的小型伪随机数发生器 */
function createRandom(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    between: (min: number, max: number) => min + next() * (max - min),
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
  }
}

/* ── 项目与任务 ───────────────────────────────────────────── */

export const DEMO_PROJECTS = [
  { name: 'agent-tower', color: 'text-indigo-600' },
  { name: 'docs-site', color: 'text-emerald-600' },
  { name: 'desktop-shell', color: 'text-rose-600' },
  { name: 'payment-gateway-service', color: 'text-amber-600' },
] as const

/** 与 components/task/adapters.ts 的项目色一致 */
export const PROJECT_COLORS = [
  'text-indigo-600',
  'text-emerald-600',
  'text-rose-600',
  'text-amber-600',
  'text-cyan-600',
  'text-violet-600',
  'text-teal-600',
  'text-pink-600',
] as const

export interface DemoTask {
  id: string
  title: string
  status: UITaskStatus
  priority: number
  project: (typeof DEMO_PROJECTS)[number]
  updatedAt: number
  agent: AgentType
  minutes: number
  additions: number
  deletions: number
}

export const DEMO_TASKS: DemoTask[] = [
  {
    id: 'task-1',
    title: '重塑左侧任务面板样式与交互',
    status: UITaskStatus.Review,
    priority: TaskPriority.HIGH,
    project: DEMO_PROJECTS[0],
    updatedAt: DEMO_NOW - 4 * MINUTE,
    agent: AgentType.CLAUDE_CODE,
    minutes: 48,
    additions: 412,
    deletions: 187,
  },
  {
    id: 'task-2',
    title: '修复 Claude 会话自动结束及停止时进程树清理超时',
    status: UITaskStatus.Running,
    priority: TaskPriority.URGENT,
    project: DEMO_PROJECTS[0],
    updatedAt: DEMO_NOW - 12 * MINUTE,
    agent: AgentType.CODEX,
    minutes: 23,
    additions: 96,
    deletions: 41,
  },
  {
    id: 'task-3',
    title: '文档站接入全文搜索',
    status: UITaskStatus.Pending,
    priority: TaskPriority.NORMAL,
    project: DEMO_PROJECTS[1],
    updatedAt: DEMO_NOW - 3 * HOUR,
    agent: AgentType.GEMINI_CLI,
    minutes: 0,
    additions: 0,
    deletions: 0,
  },
  {
    id: 'task-4',
    title: '桌面端窗口控制按钮适配 Windows',
    status: UITaskStatus.Done,
    priority: TaskPriority.LOW,
    project: DEMO_PROJECTS[2],
    updatedAt: DEMO_NOW - 2 * DAY,
    agent: AgentType.CURSOR_AGENT,
    minutes: 31,
    additions: 58,
    deletions: 12,
  },
  {
    id: 'task-5',
    title: '回调验签迁移到新密钥',
    status: UITaskStatus.Cancelled,
    priority: TaskPriority.NORMAL,
    project: DEMO_PROJECTS[3],
    updatedAt: DEMO_NOW - 9 * DAY,
    agent: AgentType.QWEN_CODE,
    minutes: 6,
    additions: 4,
    deletions: 4,
  },
  {
    id: 'task-6',
    title: '三档执行权限适配与审批闭环',
    status: UITaskStatus.Done,
    priority: TaskPriority.HIGH,
    project: DEMO_PROJECTS[0],
    updatedAt: DEMO_NOW - 26 * HOUR,
    agent: AgentType.CLAUDE_CODE,
    minutes: 74,
    additions: 865,
    deletions: 233,
  },
]

/* ── 趋势与对比 ───────────────────────────────────────────── */

/** 10/1 – 10/14 */
export const DAY_LABELS = Array.from({ length: 14 }, (_, index) => `10/${index + 1}`)

/** 每日完成任务：本期 vs 上期（按星期对齐，10/3–4、10/10–11 是周末） */
export const COMPLETED_CURRENT = [14, 17, 9, 6, 19, 22, 21, 24, 26, 12, 10, 27, 30, 33]
export const COMPLETED_PREVIOUS = [12, 13, 8, 5, 15, 16, 18, 17, 19, 9, 8, 18, 20, 21]

export const WEEK_LABELS = ['W37', 'W38', 'W39', 'W40', 'W41', 'W42']
export const MERGED_ACTUAL = [32, 41, 38, 45, 52, 36]
export const MERGED_PLAN = [40, 40, 45, 45, 50, 50]

export const DURATION_BUCKETS = [
  { id: 'lt10', label: '10 分钟内' },
  { id: '10to30', label: '10–30 分钟' },
  { id: '30to60', label: '30–60 分钟' },
  { id: 'gt60', label: '1 小时以上' },
]

export const DURATION_DATA = [
  [18, 22, 9, 4],
  [20, 25, 11, 5],
  [16, 27, 14, 6],
  [22, 30, 12, 7],
  [25, 33, 15, 6],
  [14, 19, 8, 3],
]

export const FIRST_PASS_RATE = [
  { id: 'claude', label: 'Claude Code', start: 0.62, end: 0.74, emphasis: true },
  { id: 'codex', label: 'Codex', start: 0.58, end: 0.61 },
  { id: 'cursor', label: 'Cursor Agent', start: 0.55, end: 0.6 },
  { id: 'gemini', label: 'Gemini CLI', start: 0.49, end: 0.47 },
  { id: 'qwen', label: 'Qwen Code', start: 0.41, end: 0.5 },
]

/* ── 构成与分布 ───────────────────────────────────────────── */

export const AGENT_SESSIONS = [
  { id: 'claude', agent: AgentType.CLAUDE_CODE, value: 486 },
  { id: 'codex', agent: AgentType.CODEX, value: 312 },
  { id: 'gemini', agent: AgentType.GEMINI_CLI, value: 158 },
  { id: 'cursor', agent: AgentType.CURSOR_AGENT, value: 97 },
  { id: 'qwen', agent: AgentType.QWEN_CODE, value: 41 },
]

export const TASK_FUNNEL = [
  { id: 'created', label: '创建', value: 1284 },
  { id: 'started', label: '启动 Agent', value: 1102 },
  { id: 'review', label: '提交审查', value: 864 },
  { id: 'merged', label: '合并', value: 701 },
]

/** 会话时长（分钟）× 改动行数：大体正相关，两个离群点需要关注 */
export const SESSION_POINTS = (() => {
  const random = createRandom(7)
  const points = Array.from({ length: 42 }, (_, index) => {
    const x = Math.round(random.between(3, 85))
    const y = Math.max(8, Math.round(x * random.between(5.5, 9.5) + random.between(-60, 60)))
    return { id: `s${index}`, x, y }
  })
  return [
    ...points,
    { id: 'outlier-1', x: 88, y: 64, label: '卡在依赖安装', emphasis: true },
    { id: 'outlier-2', x: 14, y: 940, label: '批量格式化', emphasis: true },
  ]
})()

export const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

export const PROJECT_WEEKDAY = [
  [24, 31, 28, 35, 29, 6, 3],
  [8, 11, 9, 14, 12, 2, 0],
  [5, 7, 12, 9, 6, 1, 1],
  [13, 10, 15, 11, 18, 4, 2],
]

/** 近 26 周每日会话数：工作日高、周末低，最近几周逐步上升 */
export const ACTIVITY_START = addDays(DEMO_TODAY, -181)
export const ACTIVITY_VALUES = (() => {
  const random = createRandom(42)
  return Array.from({ length: 182 }, (_, index) => {
    const date = addDays(ACTIVITY_START, index)
    const weekday = date.getDay()
    const weekend = weekday === 0 || weekday === 6
    const growth = 0.6 + (index / 182) * 0.8
    if (random.next() < (weekend ? 0.45 : 0.06)) return 0
    return Math.round((weekend ? random.between(0, 4) : random.between(2, 14)) * growth)
  })
})()

/* ── 排期 ─────────────────────────────────────────────────── */

/** 甘特图从 10/5（周一）开始，共 4 周；今天是第 9 天 */
export const GANTT_START = new Date(2026, 9, 5)
export const GANTT_TASKS = [
  { id: 'g1', label: '需求与设计', meta: 'shitian', start: 0, end: 4, progress: 1 },
  { id: 'g2', label: '组件库', meta: 'Claude Code', start: 3, end: 13, progress: 0.8 },
  { id: 'g3', label: '展示页', meta: 'Claude Code', start: 8, end: 16, progress: 0.45 },
  { id: 'g4', label: '主页迁移', meta: 'Codex', start: 14, end: 22, progress: 0 },
  { id: 'g5', label: '回归测试', meta: 'Gemini CLI', start: 20, end: 25, progress: 0 },
  { id: 'g6', label: '发布 v1.3', meta: 'shitian', start: 26, end: 27, progress: 0 },
]

export const CALENDAR_EVENTS = [
  { id: 'e1', date: '2026-10-02', title: '迭代周会', time: '10:00' },
  { id: 'e2', date: '2026-10-09', title: 'v1.2 发布', tone: 'success' as const },
  { id: 'e3', date: '2026-10-12', title: '迭代周会', time: '10:00' },
  { id: 'e4', date: '2026-10-14', title: '设计评审', time: '14:00' },
  { id: 'e5', date: '2026-10-14', title: '组件库提测' },
  { id: 'e6', date: '2026-10-14', title: 'TeamRun 演示', time: '17:00' },
  { id: 'e7', date: '2026-10-16', title: '隧道证书到期', tone: 'danger' as const },
  { id: 'e8', date: '2026-10-21', title: '主页迁移截止', tone: 'warning' as const },
  { id: 'e9', date: '2026-10-28', title: 'v1.3 发布' },
]
