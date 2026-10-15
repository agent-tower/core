import { useState } from 'react'
import { ArrowUpRight, FolderPlus, Inbox, Play, Plus, RotateCw, Settings, SquareTerminal, Trash2 } from 'lucide-react'
import {
  Badge,
  Button,
  CopyButton,
  CountBadge,
  EmptyState,
  IconButton,
  Kbd,
  KbdGroup,
  Notice,
  Skeleton,
  SkeletonRows,
  SkeletonText,
  Spinner,
  Tooltip,
  type BadgeVariant,
  type ButtonSize,
  type Tone,
} from '@/design-system'
import { Caption, DemoRow, ShowcaseSection, Specimen } from '../showcase'

/* ── 状态 ─────────────────────────────────────────────────── */

const BADGE_TONES: { tone: Tone; label: string }[] = [
  { tone: 'neutral', label: '草稿' },
  { tone: 'info', label: '运行中' },
  { tone: 'success', label: '已合并' },
  { tone: 'warning', label: '待审查' },
  { tone: 'danger', label: '失败' },
]

const BADGE_VARIANTS: { variant: BadgeVariant; label: string }[] = [
  { variant: 'dot', label: 'dot 圆点' },
  { variant: 'soft', label: 'soft 浅底' },
  { variant: 'outline', label: 'outline 描边' },
  { variant: 'solid', label: 'solid 实底' },
]

export function StatusSection() {
  const [notices, setNotices] = useState(true)
  return (
    <ShowcaseSection
      id="status"
      description="状态反馈从安静到醒目排成一列：圆点 → 浅底徽章 → 提示条 → 实底。越需要用户处理，越往后取。"
    >
      <Specimen
        name="Badge"
        title="徽章"
        description="一两个字的状态或属性。文字永远用 *-ink；没有状态含义的标签一律 neutral。"
        span={2}
        dos={['状态列表首选 dot：最安静，颜色只占 6px', 'solid 每屏至多一处，留给最需要注意的那一个']}
        donts={['用徽章给分类、Agent、项目上色', '徽章里放超过 6 个字的句子']}
      >
        <div className="overflow-x-auto scrollbar-app-thin">
          <div className="grid min-w-[560px] grid-cols-[96px_repeat(5,minmax(0,1fr))] items-center gap-x-3 gap-y-3">
            <span />
            {BADGE_TONES.map(item => <span key={item.tone} className="font-mono text-[10px] text-muted-foreground">{item.tone}</span>)}
            {BADGE_VARIANTS.map(row => (
              <div key={row.variant} className="contents">
                <span className="text-[11px] text-muted-foreground">{row.label}</span>
                {BADGE_TONES.map(item => (
                  <span key={item.tone}>
                    <Badge tone={item.tone} variant={row.variant}>{item.label}</Badge>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border/50 pt-4">
          <DemoRow label="尺寸">
            <Badge size="sm" tone="info">sm 18</Badge>
            <Badge tone="info">md 20</Badge>
          </DemoRow>
          <DemoRow label="形状">
            <Badge shape="tag" size="sm" className="font-semibold">P1</Badge>
            <Badge shape="tag" size="sm" tone="danger" className="font-semibold">P0</Badge>
            <Badge shape="tag" variant="outline">v1.3</Badge>
          </DemoRow>
        </div>
      </Specimen>

      <Specimen name="CountBadge" title="计数" description="分组标题、导航行右侧的数量：默认是安静的灰字，只有需要介入时才上色。" canvas="chrome">
        <div className="flex max-w-xs flex-col gap-1">
          {[
            { label: '待审查', count: 3, tone: 'warning' as Tone },
            { label: '运行中', count: 2, tone: 'neutral' as Tone },
            { label: '已完成', count: 128, tone: 'neutral' as Tone },
          ].map(group => (
            <div key={group.label} className="flex h-7 items-center rounded-md px-2 text-xs font-medium text-muted-foreground">
              {group.label}
              <CountBadge count={group.count} max={99} tone={group.tone} className="ml-auto" />
            </div>
          ))}
        </div>
        <Caption className="mt-3">超过上限显示 99+；只有「待审查」这类需要你动手的计数用 warning。</Caption>
      </Specimen>

      <Specimen name="Spinner" title="转圈" description="只用于「正在发生、时长未知」的短等待。有结构的内容用骨架，有进度的用进度条。">
        <div className="flex flex-col gap-3">
          <DemoRow label="尺寸">
            <Spinner size="xs" />
            <Spinner size="sm" />
            <Spinner size="md" />
            <Spinner size="lg" />
          </DemoRow>
          <DemoRow label="带说明">
            <Spinner label="正在读取文件" />
          </DemoRow>
          <DemoRow label="按钮内">
            <Button loading>保存中</Button>
            <Button variant="primary" loading>创建中</Button>
          </DemoRow>
        </div>
      </Specimen>

      <Specimen
        name="Notice"
        title="提示条"
        description="一段需要读到、但不打断操作的说明。颜色只给图标，正文保持墨色。"
        span={2}
        donts={['用提示条报告需要立刻处理的错误——那是对话框或 Toast 的事', '整段彩色正文']}
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <Notice tone="info" title="工作区正在准备">正在复制 .env 与 node_modules，完成后 Agent 会自动开始。</Notice>
          <Notice tone="success" title="已合并到 main">分支 feat/design-system 已删除，工作树已清理。</Notice>
          <Notice tone="warning" title="自动同意（完全访问）" action={<Button size="xs" variant="link">了解风险</Button>}>
            Agent 可以不经确认执行任意命令和网络请求。
          </Notice>
          {notices ? (
            <Notice tone="danger" title="合并冲突" onDismiss={() => setNotices(false)}>
              src/index.css 有 2 处冲突，解决后才能继续合并。
            </Notice>
          ) : (
            <div className="flex items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
              <Button size="xs" variant="ghost" onClick={() => setNotices(true)}>恢复示例</Button>
            </div>
          )}
          <Notice className="lg:col-span-2">修改在新运行实例启动时生效，运行中的会话保留启动时的权限。</Notice>
        </div>
      </Specimen>

      <Specimen name="EmptyState" title="空状态" description="说清楚「为什么是空的、下一步做什么」：图标浅灰细描边，一句话，至多一个主操作。">
        <EmptyState
          icon={<Inbox />}
          title="还没有任务"
          description="在上方输入框描述一件事，Agent 会在独立的工作树里完成它。"
          action={<Button variant="primary" size="sm"><Plus />新建任务</Button>}
          className="py-6"
        />
      </Specimen>

      <Specimen name="EmptyState · dashed" title="面板内空状态" description="嵌在面板、列表、拖放区里时用虚线框 + 小号。">
        <div className="flex flex-col gap-3">
          <EmptyState variant="dashed" size="sm" icon={<FolderPlus />} title="没有变更文件" description="Agent 修改文件后会出现在这里" />
          <EmptyState variant="dashed" size="sm" description="拖入文件或粘贴截图作为附件" />
        </div>
      </Specimen>

      <Specimen
        name="Skeleton"
        title="骨架"
        description="首次加载有固定结构的内容时使用，几何与真实内容一致，加载完不跳动。"
        span={2}
        donts={['刷新已有数据时闪骨架——保留旧内容，降低不透明度即可']}
      >
        <div className="grid gap-6 md:grid-cols-3">
          <div>
            <Caption className="mb-2">列表行（与 32px 侧栏行同几何）</Caption>
            <SkeletonRows rows={4} />
          </div>
          <div>
            <Caption className="mb-2">段落</Caption>
            <SkeletonText lines={4} />
          </div>
          <div>
            <Caption className="mb-2">卡片</Caption>
            <div className="rounded-xl border border-border/60 p-4">
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-8" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-2.5 w-2/3" />
                  <Skeleton className="h-2 w-1/3" />
                </div>
              </div>
              <Skeleton className="mt-4 h-16 w-full rounded-lg" />
            </div>
          </div>
        </div>
      </Specimen>
    </ShowcaseSection>
  )
}

/* ── 操作 ─────────────────────────────────────────────────── */

const SIZES: ButtonSize[] = ['xs', 'sm', 'md', 'lg', 'xl']

export function ActionsSection() {
  return (
    <ShowcaseSection
      id="actions"
      description="按钮按强调程度分五种：primary 只给这一屏最重要的一件事，其余从 secondary 往下取。危险操作只换语气，不新增形状。"
    >
      <Specimen
        name="Button"
        title="按钮"
        description="默认 secondary（描边白卡），高度 32px 与侧栏行对齐。"
        span={2}
        dos={['一屏一个 primary；对话框里主按钮放最右', '文案写动作本身：「创建任务」「合并」，而不是「确定」']}
        donts={['两个 primary 并排', '用 danger 表达普通的取消或关闭']}
      >
        <div className="flex flex-col gap-4">
          <DemoRow label="primary">
            <Button variant="primary"><Play />开始</Button>
            <Button variant="primary">创建任务</Button>
            <Button variant="primary" loading>创建中</Button>
            <Button variant="primary" disabled>开始</Button>
          </DemoRow>
          <DemoRow label="secondary">
            <Button><Plus />新建项目</Button>
            <Button>导入</Button>
            <Button disabled>导入</Button>
          </DemoRow>
          <DemoRow label="ghost">
            <Button variant="ghost"><SquareTerminal />打开终端</Button>
            <Button variant="ghost">取消</Button>
          </DemoRow>
          <DemoRow label="soft">
            <Button variant="soft"><RotateCw />重试</Button>
            <Button variant="soft">更多选项</Button>
          </DemoRow>
          <DemoRow label="link">
            <Button variant="link">查看文档</Button>
            <Button variant="link">了解执行权限<ArrowUpRight /></Button>
          </DemoRow>
          <DemoRow label="danger">
            <Button variant="primary" tone="danger"><Trash2 />删除项目</Button>
            <Button tone="danger">终止会话</Button>
            <Button variant="ghost" tone="danger">移除</Button>
            <Button variant="soft" tone="danger">放弃更改</Button>
          </DemoRow>
          <DemoRow label="尺寸">
            {SIZES.map(size => <Button key={size} size={size} variant={size === 'xl' ? 'primary' : 'secondary'}>{size}</Button>)}
          </DemoRow>
        </div>
      </Specimen>

      <Specimen
        name="IconButton"
        title="图标按钮"
        description="工具栏、行尾操作、关闭。默认 ghost：灰色图标，悬停才浮出底色。必须有读屏名称。"
        dos={['含义不自明的图标外包 Tooltip']}
      >
        <div className="flex flex-col gap-4">
          <DemoRow label="ghost">
            {SIZES.map(size => (
              <IconButton key={size} size={size} label={`设置（${size}）`}>
                <Settings />
              </IconButton>
            ))}
          </DemoRow>
          <DemoRow label="secondary">
            <IconButton variant="secondary" label="刷新"><RotateCw /></IconButton>
            <IconButton variant="secondary" size="sm" label="新建"><Plus /></IconButton>
            <IconButton variant="secondary" tone="danger" label="删除"><Trash2 /></IconButton>
          </DemoRow>
          <DemoRow label="带提示">
            <Tooltip content="打开终端" shortcut={['⌃', '`']}>
              <IconButton label="打开终端" showTitle={false}><SquareTerminal /></IconButton>
            </Tooltip>
            <Tooltip content="刷新">
              <IconButton label="刷新" showTitle={false}><RotateCw /></IconButton>
            </Tooltip>
            <IconButton label="加载中" loading><RotateCw /></IconButton>
          </DemoRow>
        </div>
      </Specimen>

      <Specimen name="CopyButton" title="复制" description="点击后对勾 1.6 秒，文案同步变「已复制」，读屏同样播报。">
        <div className="flex flex-col gap-4">
          <DemoRow label="图标">
            <span className="flex items-center gap-1 font-mono text-xs text-foreground/80">
              8721b9c
              <CopyButton value="8721b9c" size="xs" />
            </span>
          </DemoRow>
          <DemoRow label="图标 + 文字">
            <CopyButton value="pnpm --filter web build" display="text" variant="secondary" />
            <CopyButton value="feat/design-system" display="text" label="复制分支名" />
          </DemoRow>
        </div>
      </Specimen>

      <Specimen name="Kbd" title="按键" description="快捷键提示：单键、组合键；在深色 Tooltip 里用反色版本。">
        <div className="flex flex-col gap-4">
          <DemoRow label="单键">
            <Kbd>⏎</Kbd>
            <Kbd>Esc</Kbd>
            <Kbd>⌘</Kbd>
            <Kbd>Tab</Kbd>
          </DemoRow>
          <DemoRow label="组合">
            <KbdGroup keys={['⌘', 'K']} />
            <KbdGroup keys={['Ctrl', 'Enter']} separator="+" />
            <KbdGroup keys={['⇧', '⏎']} />
          </DemoRow>
          <DemoRow label="反色">
            <span className="flex items-center gap-2 rounded-lg bg-inverse px-2.5 py-1.5 text-xs text-inverse-foreground">
              搜索任务
              <KbdGroup keys={['⌘', 'K']} inverse />
            </span>
          </DemoRow>
        </div>
      </Specimen>

      <Specimen name="Toolbar" title="工具栏" description="一组图标按钮 + 一个文字按钮；同一工具栏里所有控件同高（28px）。" canvas="chrome">
        <div className="flex items-center gap-1 rounded-lg bg-background p-1 shadow-raised ring-1 ring-border/70">
          <IconButton size="sm" label="刷新"><RotateCw /></IconButton>
          <IconButton size="sm" label="打开终端"><SquareTerminal /></IconButton>
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
          <Button size="sm" variant="ghost">提交</Button>
          <Button size="sm" variant="primary" className="ml-auto">合并</Button>
        </div>
      </Specimen>
    </ShowcaseSection>
  )
}
