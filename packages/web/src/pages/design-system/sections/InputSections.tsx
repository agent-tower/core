import { useRef, useState, type ReactNode } from 'react'
import { AgentType } from '@agent-tower/shared'
import {
  CalendarDays,
  ChevronRight,
  Columns3,
  Copy,
  ExternalLink,
  FileText,
  Flag,
  FolderOpen,
  GitBranch,
  ListFilter,
  Paperclip,
  Pencil,
  Rows3,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { AgentLogo } from '@/components/agent/AgentLogo'
import {
  Button,
  Checkbox,
  Chip,
  ChipSelect,
  Composer,
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  Field,
  IconButton,
  Input,
  KbdGroup,
  Menu,
  MENU_ITEM,
  MENU_ITEM_DANGER,
  MENU_LABEL,
  MENU_SEPARATOR,
  MENU_SHORTCUT,
  MENU_SURFACE,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  ProjectDot,
  RadioGroup,
  SearchField,
  Segmented,
  Select,
  Slider,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tag,
  Textarea,
  Tooltip,
} from '@/design-system'
import { getAgentLabel } from '@/lib/agent-meta'
import { cn } from '@/lib/utils'
import { DEMO_PROJECTS } from '../demo-data'
import { Caption, DemoRow, ShowcaseSection, Specimen } from '../showcase'

/* ── 输入 ─────────────────────────────────────────────────── */

const EFFORT_LABELS = ['低', '中', '高', '极高']

const PERMISSION_OPTIONS = [
  { value: 'ask', label: '请求批准', description: '遵循原生审批规则，已允许的操作可以直接执行。' },
  { value: 'sandbox', label: '自动同意（沙箱）', description: '使用原生沙箱与自动审阅，部分操作仍可能请求批准。' },
  { value: 'full', label: '自动同意（完全访问）', description: '关闭可配置沙箱，上游强制规则仍然生效。' },
]

const AGENT_CHOICES = [
  ...[AgentType.CLAUDE_CODE, AgentType.CODEX, AgentType.GEMINI_CLI].map(agent => ({
    value: agent,
    label: getAgentLabel(agent),
    icon: <AgentLogo agentType={agent} className="size-3.5" />,
  })),
  {
    value: AgentType.CURSOR_AGENT,
    label: getAgentLabel(AgentType.CURSOR_AGENT),
    icon: <AgentLogo agentType={AgentType.CURSOR_AGENT} className="size-3.5" />,
    description: '未检测到 cursor-agent 命令',
    disabled: true,
  },
]

function SliderDemo() {
  const [concurrency, setConcurrency] = useState([4])
  const [effort, setEffort] = useState([2])
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mb-2 flex items-baseline justify-between text-[13px]">
          <span className="font-medium text-foreground">并发会话上限</span>
          <span className="tabular-nums text-foreground/80">{concurrency[0]} 个</span>
        </div>
        <Slider value={concurrency} onValueChange={setConcurrency} min={1} max={10} aria-label="并发会话上限" />
      </div>
      <div>
        <div className="mb-2 flex items-baseline justify-between text-[13px]">
          <span className="font-medium text-foreground">推理强度</span>
          <span className="text-foreground/80">{EFFORT_LABELS[effort[0]]}</span>
        </div>
        <Slider value={effort} onValueChange={setEffort} min={0} max={3} step={1} marks={[0, 1, 2, 3]} aria-label="推理强度" />
        <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
          {EFFORT_LABELS.map(label => <span key={label}>{label}</span>)}
        </div>
      </div>
    </div>
  )
}

function ChipDemo() {
  const [selected, setSelected] = useState<string[]>(['agent-tower'])
  const [files, setFiles] = useState(['design-system.png', 'tokens.css', 'TaskList.tsx'])
  const toggle = (name: string) => setSelected(current => (current.includes(name) ? current.filter(item => item !== name) : [...current, name]))
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1.5">
        <Chip selected={selected.length === 0} onClick={() => setSelected([])}>全部项目</Chip>
        {DEMO_PROJECTS.slice(0, 3).map((project, index) => (
          <Chip
            key={project.name}
            selected={selected.includes(project.name)}
            onClick={() => toggle(project.name)}
            icon={<ProjectDot color={project.color} />}
            count={[24, 7, 3][index]}
          >
            {project.name}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {files.map(file => (
          <Tag key={file} icon={<FileText />} onRemove={() => setFiles(current => current.filter(item => item !== file))}>
            {file}
          </Tag>
        ))}
        {files.length === 0 && (
          <Button size="xs" variant="ghost" onClick={() => setFiles(['design-system.png', 'tokens.css', 'TaskList.tsx'])}>恢复示例</Button>
        )}
      </div>
    </div>
  )
}

function ComposerDemo() {
  const [submitting, setSubmitting] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const submit = () => {
    setSubmitting(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setSubmitting(false), 1800)
  }
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center py-4">
      <h3 className="mb-6 text-center text-[26px] font-medium leading-snug tracking-tight text-foreground">你需要在 agent-tower 中做点什么？</h3>
      <Composer
        placeholder="描述一个任务，Agent 会在独立工作树里完成它"
        defaultValue="把左侧任务面板改成紧凑的两行布局"
        submitLabel="创建并启动"
        submitHint="创建并启动"
        submitting={submitting}
        pendingLabel="正在创建工作区…"
        onSubmit={submit}
        toolbarStart={<IconButton size="sm" label="添加附件"><Paperclip /></IconButton>}
        footer={(
          <>
            <ChipSelect
              aria-label="项目"
              defaultValue="agent-tower"
              options={DEMO_PROJECTS.map(project => ({ value: project.name, label: project.name, icon: <ProjectDot color={project.color} /> }))}
            />
            <ChipSelect aria-label="Agent" defaultValue={AgentType.CLAUDE_CODE} options={AGENT_CHOICES} />
            <ChipSelect
              aria-label="工作区"
              defaultValue="worktree"
              icon={<GitBranch />}
              menuWidth="lg"
              options={[
                { value: 'worktree', label: '新建工作树', description: '在独立分支上工作，不影响主目录' },
                { value: 'local', label: '本地目录', description: '直接修改项目目录，适合一次性小改动' },
              ]}
            />
          </>
        )}
      />
    </div>
  )
}

export function InputsSection() {
  const [note, setNote] = useState('先读 TaskList.tsx 与 sidebar-styles.ts，保持 32px 行高；元信息悬停时收起。')
  return (
    <ShowcaseSection
      id="inputs"
      description="输入控件共用一个外壳：白底、1px 边框、10px 圆角。焦点 = 边框加深为中性灰；错误 = 红边框 + 字段下方一行红字，不弹窗、不清空输入。"
    >
      <Specimen
        name="Field · Input"
        title="字段与输入框"
        description="标签在上、说明在下；Field 自动把 id、说明、错误态接到内部控件上。"
        span={2}
        dos={['错误信息说清楚怎么改：「目录不是 Git 仓库」而不是「输入有误」']}
        donts={['用占位符代替标签', '输入时就报错——等失焦或提交时再校验']}
      >
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="项目名称" required description="用于侧栏与任务标签，可随时修改">
            <Input defaultValue="agent-tower" />
          </Field>
          <Field label="仓库路径" error="这个目录不是 Git 仓库，初始化后才能使用工作树">
            <Input defaultValue="/Users/shitian/Work/notes" prefix={<FolderOpen />} />
          </Field>
          <Field label="开发端口" description="留空则按项目自动分配">
            <Input placeholder="5173" inputMode="numeric" suffix={<span className="text-xs">端口</span>} />
          </Field>
          <Field label="分支前缀" counter="7 / 24">
            <Input size="sm" defaultValue="feat/ds" />
          </Field>
          <Field label="默认分支" description="只读：由仓库决定">
            <Input disabled defaultValue="main" />
          </Field>
        </div>
      </Specimen>

      <Specimen name="Textarea" title="多行输入" description="Prompt、脚本、说明文字；可随内容增高。">
        <Field label="任务说明" counter={`${note.length} / 500`}>
          <Textarea autoResize minRows={3} maxRows={6} value={note} onChange={event => setNote(event.target.value.slice(0, 500))} />
        </Field>
      </Specimen>

      <Specimen name="SearchField" title="搜索" description="放大镜前缀；有内容时出现清除按钮，Esc 同样清空。">
        <div className="flex flex-col gap-3">
          <SearchField placeholder="搜索任务" shortcut={['⌘', 'K']} aria-label="搜索任务" />
          <SearchField size="sm" defaultValue="design" placeholder="筛选文件" aria-label="筛选文件" />
        </div>
      </Specimen>

      <Specimen name="Select" title="选择框" description="5 个以上互斥选项时用；更少时用分段或单选，全部可见更快。">
        <div className="flex flex-col gap-4">
          <Field label="Provider">
            <Select
              defaultValue="anthropic"
              options={[
                { value: 'anthropic', label: 'Anthropic 官方', description: '使用 Claude Code 自带的登录' },
                { value: 'bedrock', label: 'AWS Bedrock', description: '按 AWS 账号计费' },
                { value: 'vertex', label: 'Google Vertex AI' },
                { value: 'proxy', label: '自定义代理', description: '兼容 Anthropic API 的网关' },
                { value: 'disabled', label: 'OpenRouter', description: '尚未配置密钥', disabled: true },
              ]}
            />
          </Field>
          <Field label="目标分支">
            <Select
              size="sm"
              placeholder="选择分支"
              options={['main', 'develop', 'release/1.3', 'feat/design-system', 'fix/session-timeout'].map(branch => ({ value: branch, label: branch, icon: <GitBranch /> }))}
            />
          </Field>
        </div>
      </Specimen>

      <Specimen name="Slider" title="滑块" description="连续或分档取值；精确数值必须同时以文字显示。">
        <SliderDemo />
      </Specimen>

      <Specimen name="Segmented" title="分段选择" description="2–5 个互斥选项、切换后原地刷新内容。选中段是浮起的白卡。">
        <div className="flex flex-col gap-4">
          <Segmented
            aria-label="视图"
            defaultValue="list"
            options={[
              { value: 'list', label: '列表', icon: <Rows3 /> },
              { value: 'board', label: '看板', icon: <Columns3 /> },
              { value: 'calendar', label: '日历', icon: <CalendarDays /> },
            ]}
          />
          <Segmented
            aria-label="任务状态"
            defaultValue="all"
            options={[
              { value: 'all', label: '全部', count: 24 },
              { value: 'running', label: '运行中', count: 3 },
              { value: 'review', label: '待审查', count: 2 },
            ]}
          />
          <Segmented
            aria-label="时间范围"
            size="sm"
            defaultValue="30"
            options={[
              { value: '7', label: '7 天' },
              { value: '30', label: '30 天' },
              { value: '90', label: '90 天' },
            ]}
          />
        </div>
      </Specimen>

      <Specimen name="Tabs" title="标签页" description="同一对象的不同面，切换整块内容区。下划线式，切换时字重不变、不抖动。">
        <Tabs defaultValue="changes">
          <TabsList>
            <TabsTrigger value="conversation">对话</TabsTrigger>
            <TabsTrigger value="changes" count={12}>变更</TabsTrigger>
            <TabsTrigger value="terminal">终端</TabsTrigger>
            <TabsTrigger value="preview" disabled>预览</TabsTrigger>
          </TabsList>
          <TabsContent value="conversation"><Caption>与 Agent 的对话记录。</Caption></TabsContent>
          <TabsContent value="changes"><Caption>12 个文件有改动，+412 −187。</Caption></TabsContent>
          <TabsContent value="terminal"><Caption>工作区终端。</Caption></TabsContent>
        </Tabs>
      </Specimen>

      <Specimen name="Chip · Tag" title="筛选胶囊与标签" description="胶囊是可切换的筛选条件，选中为 Charcoal 实心；标签是已添加的条目，可移除。">
        <ChipDemo />
      </Specimen>

      <Specimen name="ChipSelect" title="胶囊选择器" description="输入卡下方、工具栏里的轻量参数：平时只是灰字 + 图标，悬停才浮出底色；点开是单选菜单。">
        <div className="flex flex-col gap-3">
          <DemoRow label="已选">
            <ChipSelect aria-label="Agent" defaultValue={AgentType.CLAUDE_CODE} options={AGENT_CHOICES} />
            <ChipSelect aria-label="执行权限" icon={<ShieldCheck />} defaultValue="ask" menuWidth="lg" showMenuLabel options={PERMISSION_OPTIONS} />
          </DemoRow>
          <DemoRow label="未选">
            <ChipSelect
              aria-label="目标分支"
              icon={<GitBranch />}
              placeholder="选择分支"
              options={['main', 'release/1.3', 'feat/design-system'].map(branch => ({ value: branch, label: branch }))}
            />
          </DemoRow>
          <DemoRow label="禁用">
            <ChipSelect aria-label="Provider" disabled defaultValue="official" options={[{ value: 'official', label: 'Anthropic 官方' }]} />
          </DemoRow>
        </div>
        <Caption className="mt-4">不可用的选项留在菜单里并写明原因（点开 Agent 看 Cursor Agent）；带说明的选项用宽菜单 menuWidth="lg"。</Caption>
      </Specimen>

      <Specimen
        name="Switch · Checkbox · Radio"
        title="开关、复选与单选"
        description="开关立即生效；复选框用于需要提交的选择；单选用于 2–5 个需要读说明才能选的互斥项。"
        span={2}
      >
        <div className="grid gap-8 lg:grid-cols-3">
          <div className="flex flex-col divide-y divide-border/50">
            {[
              { label: '任务完成时发送系统通知', checked: true },
              { label: '自动生成提交信息', checked: false },
              { label: '合并后删除工作树', checked: true, disabled: true },
            ].map(item => (
              <label key={item.label} className={cn('flex items-center justify-between gap-4 py-2.5 first:pt-0', item.disabled && 'opacity-50')}>
                <span className="text-[13px] text-foreground">{item.label}</span>
                <Switch defaultChecked={item.checked} disabled={item.disabled} aria-label={item.label} />
              </label>
            ))}
          </div>
          <div className="flex flex-col gap-3">
            <Checkbox defaultChecked label="合并后删除分支" />
            <Checkbox label="推送前运行测试" description="在工作树里执行 pnpm test，失败则中止推送" />
            <Checkbox checked="indeterminate" label="选中 3 / 5 个文件" />
            <Checkbox disabled label="签名提交（未配置 GPG）" />
          </div>
          <RadioGroup aria-label="执行权限" defaultValue="ask" options={PERMISSION_OPTIONS} />
        </div>
      </Specimen>

      <Specimen
        name="Composer"
        title="输入卡"
        description="主页的「一句话发起任务」：Enter 提交、Shift+Enter 换行，输入法组字时不提交。参数用卡片下方的胶囊，不塞进卡片里。"
        span={2}
      >
        <ComposerDemo />
      </Specimen>
    </ShowcaseSection>
  )
}

/* ── 浮层 ─────────────────────────────────────────────────── */

/** 静态样张的菜单项：与 MenuItem / MenuSubTrigger 用同一套类名，展开后长什么样一眼可见 */
function StaticMenuItem({ icon, trailing, tone = 'neutral', highlighted = false, children }: {
  icon: ReactNode
  trailing?: ReactNode
  tone?: 'neutral' | 'danger'
  highlighted?: boolean
  children: ReactNode
}) {
  return (
    <div className={cn(MENU_ITEM, tone === 'danger' && MENU_ITEM_DANGER, highlighted && 'bg-accent text-foreground')}>
      <span className={cn('flex shrink-0', tone === 'danger' ? 'text-current' : 'text-muted-foreground')}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </div>
  )
}

function StaticMenu() {
  return (
    <div className={cn(MENU_SURFACE, 'w-60')} role="presentation">
      <div className={MENU_LABEL}>任务</div>
      <StaticMenuItem icon={<ExternalLink />} trailing={<span className={MENU_SHORTCUT}>⌘⏎</span>}>在新标签页打开</StaticMenuItem>
      <StaticMenuItem icon={<Copy />} highlighted>复制分支名</StaticMenuItem>
      <StaticMenuItem icon={<Pencil />} trailing={<span className={MENU_SHORTCUT}>F2</span>}>重命名</StaticMenuItem>
      <div className={MENU_SEPARATOR} />
      <StaticMenuItem icon={<Flag />} trailing={<ChevronRight className="ml-auto size-3.5 text-muted-foreground" />}>优先级</StaticMenuItem>
      <div className={MENU_SEPARATOR} />
      <StaticMenuItem icon={<Trash2 />} tone="danger">删除任务</StaticMenuItem>
    </div>
  )
}

function FilterFields() {
  return (
    <>
      <div className="mb-2 text-xs font-medium text-muted-foreground">状态</div>
      <div className="flex flex-col gap-2">
        <Checkbox defaultChecked label="运行中" />
        <Checkbox defaultChecked label="待审查" />
        <Checkbox label="已完成" />
      </div>
    </>
  )
}

function DialogDemo() {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const confirm = () => {
    setDeleting(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setDeleting(false)
      setConfirmOpen(false)
    }, 1200)
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Dialog>
        <DialogTrigger asChild>
          <Button>新建项目</Button>
        </DialogTrigger>
        <DialogContent
          title="新建项目"
          description="选择一个 Git 仓库，Agent 会在它的工作树里完成任务。"
          footer={(
            <>
              <DialogClose asChild><Button variant="ghost">取消</Button></DialogClose>
              <DialogClose asChild><Button variant="primary">创建项目</Button></DialogClose>
            </>
          )}
        >
          <div className="flex flex-col gap-4">
            <Field label="项目名称" required><Input defaultValue="agent-tower" /></Field>
            <Field label="仓库路径" description="必须是 Git 仓库的根目录"><Input defaultValue="~/Work/agent-tower" prefix={<FolderOpen />} /></Field>
          </div>
        </DialogContent>
      </Dialog>
      <Button tone="danger" onClick={() => setConfirmOpen(true)}>删除项目…</Button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        tone="danger"
        title="删除项目 agent-tower？"
        description="项目下的 24 个任务与工作树会一起删除，仓库本身不受影响。删除后无法恢复。"
        confirmLabel="删除项目"
        cancelLabel="取消"
        loading={deleting}
        onConfirm={confirm}
      />
    </div>
  )
}

export function OverlaysSection() {
  const [priority, setPriority] = useState('high')
  return (
    <ShowcaseSection
      id="overlays"
      description="浮层共用一种材质：白底、1px 边框、popover 阴影、10px 圆角。由轻到重：Tooltip → 菜单 → 气泡面板 → 对话框。"
    >
      <Specimen
        name="Menu"
        title="菜单"
        description="条目 13px、8px 圆角；图标在左、快捷键在右，危险操作放最后并用分隔线隔开。"
        canvas="chrome"
        dos={['菜单文案用动词开头：「复制分支名」', '危险项放最后，前面加分隔线']}
        donts={['在菜单里放表单——那是气泡面板的事']}
      >
        <div className="flex flex-wrap items-start gap-6">
          <StaticMenu />
          <div className="flex flex-col items-start gap-3">
            <Caption>可交互版本：</Caption>
            <Menu>
              <MenuTrigger asChild>
                <Button size="sm">任务操作</Button>
              </MenuTrigger>
              <MenuContent className="w-56">
                <MenuLabel>任务</MenuLabel>
                <MenuItem icon={<ExternalLink />} shortcut="⌘⏎">在新标签页打开</MenuItem>
                <MenuItem icon={<Copy />}>复制分支名</MenuItem>
                <MenuSeparator />
                <MenuSub>
                  <MenuSubTrigger icon={<Flag />}>优先级</MenuSubTrigger>
                  <MenuSubContent>
                    <MenuRadioGroup value={priority} onValueChange={setPriority}>
                      <MenuRadioItem value="urgent">P0 紧急</MenuRadioItem>
                      <MenuRadioItem value="high">P1 高</MenuRadioItem>
                      <MenuRadioItem value="normal">P2 普通</MenuRadioItem>
                      <MenuRadioItem value="low">P3 低</MenuRadioItem>
                    </MenuRadioGroup>
                  </MenuSubContent>
                </MenuSub>
                <MenuSeparator />
                <MenuItem icon={<Trash2 />} tone="danger">删除任务</MenuItem>
              </MenuContent>
            </Menu>
            <ContextMenu>
              <ContextMenuTrigger className="flex h-20 w-44 items-center justify-center rounded-lg border border-dashed border-border bg-background text-xs text-muted-foreground">
                在这里右键
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ContextMenuItem icon={<Copy />}>复制路径</ContextMenuItem>
                <ContextMenuItem icon={<ExternalLink />}>在编辑器中打开</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem icon={<Trash2 />} tone="danger">删除文件</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </div>
        </div>
      </Specimen>

      <Specimen
        name="Tooltip"
        title="悬停提示"
        description="深色反色面、无箭头，只放补充信息；键盘聚焦同样出现。"
        donts={['把必须知道的信息只藏在 Tooltip 里']}
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex max-w-[260px] items-center gap-2 rounded-lg bg-inverse px-2.5 py-1.5 text-xs leading-relaxed text-inverse-foreground shadow-popover">
              搜索任务
              <KbdGroup keys={['⌘', 'K']} inverse />
            </span>
            <span className="max-w-[220px] rounded-lg bg-inverse px-2.5 py-1.5 text-xs leading-relaxed text-inverse-foreground shadow-popover">
              修复 Claude 会话自动结束及停止时进程树清理超时
            </span>
          </div>
          <DemoRow label="悬停试试">
            <Tooltip content="刷新状态">
              <Button size="sm" variant="ghost">刷新</Button>
            </Tooltip>
            <Tooltip content="新建任务" shortcut={['⌘', 'N']}>
              <Button size="sm">新建</Button>
            </Tooltip>
            <Tooltip content="下方显示" side="bottom">
              <Button size="sm" variant="ghost">下方</Button>
            </Tooltip>
          </DemoRow>
        </div>
      </Specimen>

      <Specimen name="Popover" title="气泡面板" description="小表单、筛选器、详情预览：比菜单内容多，又不值得开对话框。" canvas="chrome">
        <div className="flex flex-wrap items-start gap-6">
          <div className="w-64 rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-popover" role="presentation">
            <FilterFields />
            <div className="mt-3 flex justify-end gap-1.5 border-t border-border/60 pt-3">
              <Button size="sm" variant="ghost">重置</Button>
              <Button size="sm" variant="primary">应用</Button>
            </div>
          </div>
          <div className="flex flex-col items-start gap-3">
            <Caption>可交互版本：</Caption>
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm"><ListFilter />筛选</Button>
              </PopoverTrigger>
              <PopoverContent className="w-64">
                <FilterFields />
                <div className="mt-3 flex justify-end gap-1.5 border-t border-border/60 pt-3">
                  <PopoverClose asChild><Button size="sm" variant="ghost">重置</Button></PopoverClose>
                  <PopoverClose asChild><Button size="sm" variant="primary">应用</Button></PopoverClose>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        <Caption className="mt-4">与菜单同材质，内边距 12px；底部操作区与对话框一致，主按钮在右。</Caption>
      </Specimen>

      <Specimen
        name="Dialog"
        title="对话框"
        description="需要专注完成的一件事。遮罩 20% 黑，面板 14px 圆角；Esc 或点遮罩关闭，焦点在关闭后归还。"
        dos={['确认框写清后果：「删除后无法恢复」', '主按钮写动作本身：「删除项目」']}
        donts={['对话框里再开对话框']}
      >
        <div className="mb-4 overflow-hidden rounded-xl border border-border bg-background shadow-overlay">
          <div className="px-4 pb-2 pt-4">
            <div className="text-[15px] font-semibold text-foreground">删除项目 agent-tower？</div>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">项目下的 24 个任务与工作树会一起删除。删除后无法恢复。</p>
          </div>
          <div className="flex justify-end gap-2 border-t border-border/60 bg-foreground/[0.015] px-4 py-2.5">
            <Button size="sm" variant="ghost">取消</Button>
            <Button size="sm" variant="primary" tone="danger">删除项目</Button>
          </div>
        </div>
        <DialogDemo />
      </Specimen>
    </ShowcaseSection>
  )
}
