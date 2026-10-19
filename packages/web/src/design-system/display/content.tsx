import type { ComponentProps, ReactNode } from 'react'
import { File, FileCode, FileImage, FileText, GitCommitHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CopyButton } from '../actions/copy-button'
import { DiffStat } from '../domain/tags'
import { TONE_INK, TONE_SOFT } from '../tokens'
import { fileChangeTone, type FileChangeStatus } from './file-change'

const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'json', 'css', 'html', 'py', 'go', 'rs', 'java', 'sh', 'yml', 'yaml', 'toml', 'prisma', 'sql'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'])
const TEXT_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'log'])

/** 文件类型图标：按扩展名分代码 / 图片 / 文本 / 其他，一律中性灰（类型不是状态，不着色） */
export function FileGlyph({ name, className }: { name: string; className?: string }) {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  const Glyph = CODE_EXTENSIONS.has(extension) ? FileCode : IMAGE_EXTENSIONS.has(extension) ? FileImage : TEXT_EXTENSIONS.has(extension) ? FileText : File
  return <Glyph aria-hidden="true" className={cn('size-3.5 shrink-0 text-muted-foreground', className)} />
}

function splitPath(path: string) {
  const index = path.lastIndexOf('/')
  return index === -1 ? { dir: '', name: path } : { dir: path.slice(0, index), name: path.slice(index + 1) }
}

/* ── 文件 ─────────────────────────────────────────────────── */

export interface FileStatusBadgeProps {
  /** Git 状态字母：A 新增 · M 修改 · D 删除 · R 重命名；其他字母按修改显示 */
  status: string
  /** sm 16px（列表行，默认）· md 20px（手机上的触控行） */
  size?: 'sm' | 'md'
  className?: string
}

/** 文件变更状态字母：浅着色方块 + *-ink 字母，全站文件列表共用这一种 */
export function FileStatusBadge({ status, size = 'sm', className }: FileStatusBadgeProps) {
  const tone = fileChangeTone(status)
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-[3px] font-mono font-semibold',
        size === 'sm' ? 'size-4 text-[10px]' : 'size-5 text-[11px]',
        TONE_SOFT[tone],
        TONE_INK[tone],
        className,
      )}
    >
      {status}
    </span>
  )
}

export interface FileRowProps extends Omit<ComponentProps<'button'>, 'children'> {
  path: string
  status?: FileChangeStatus
  additions?: number
  deletions?: number
  active?: boolean
}

/** 变更文件行：状态字母 · 文件名（等宽）· 目录（灰，从左截断）· 增删统计 */
export function FileRow({ path, status, additions, deletions, active = false, className, type, ...props }: FileRowProps) {
  const { dir, name } = splitPath(path)
  return (
    <button
      type={type ?? 'button'}
      title={path}
      aria-current={active || undefined}
      className={cn(
        'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        active ? 'bg-background shadow-raised ring-1 ring-border/80' : 'hover:bg-accent',
        className,
      )}
      {...props}
    >
      {status && <FileStatusBadge status={status} />}
      <FileGlyph name={name} />
      <span className="min-w-0 truncate font-mono text-xs text-foreground/90">{name}</span>
      {/* rtl 让过长的目录从左侧截断；内层 ltr 隔离，避免首尾的「/」「.」被挪到另一端 */}
      <span className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-muted-foreground [direction:rtl]">
        <span dir="ltr">{dir}</span>
      </span>
      {(additions !== undefined || deletions !== undefined) && <DiffStat additions={additions} deletions={deletions} />}
    </button>
  )
}

/** 文件引用胶囊：正文里提到的文件（@src/index.css） */
export function FileChip({ path, className }: { path: string; className?: string }) {
  const { name } = splitPath(path)
  return (
    <span title={path} className={cn('inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-foreground/[0.05] px-1.5 align-middle font-mono text-[11px] text-foreground/85', className)}>
      <FileGlyph name={name} className="size-3" />
      <span className="truncate">{name}</span>
    </span>
  )
}

/* ── 提交 ─────────────────────────────────────────────────── */

export interface CommitItemProps {
  message: ReactNode
  hash: string
  author?: ReactNode
  time?: ReactNode
  additions?: number
  deletions?: number
  className?: string
}

/** 提交记录：提交信息一行 · 作者与时间 · 等宽短哈希（可复制） */
export function CommitItem({ message, hash, author, time, additions, deletions, className }: CommitItemProps) {
  return (
    <div className={cn('flex items-center gap-2.5 py-2', className)}>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/[0.05] text-muted-foreground">
        <GitCommitHorizontal aria-hidden="true" className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-foreground/90">{message}</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {author}
          {author && time && <span aria-hidden="true">·</span>}
          {time}
          {(additions !== undefined || deletions !== undefined) && <DiffStat additions={additions} deletions={deletions} className="ml-1" />}
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-0.5">
        <code className="font-mono text-[11px] text-muted-foreground">{hash.slice(0, 7)}</code>
        <CopyButton value={hash} size="xs" />
      </span>
    </div>
  )
}

/* ── 代码 ─────────────────────────────────────────────────── */

export interface CodeBlockProps {
  code: string
  /** 左上角说明：语言或文件名 */
  title?: ReactNode
  lineNumbers?: boolean
  className?: string
}

/** 代码块：浅灰底等宽 12px，行高 20px；右上角复制。长行横向滚动，不自动折行 */
export function CodeBlock({ code, title, lineNumbers = false, className }: CodeBlockProps) {
  const lines = code.replace(/\n$/, '').split('\n')
  return (
    <div className={cn('overflow-hidden rounded-lg border border-border/60 bg-foreground/[0.025]', className)}>
      <div className="flex h-8 items-center justify-between border-b border-border/50 pl-3 pr-1">
        <span className="truncate font-mono text-[11px] text-muted-foreground">{title}</span>
        <CopyButton value={code} size="xs" />
      </div>
      <pre className="overflow-x-auto py-2.5 font-mono text-xs leading-5 text-foreground/90 scrollbar-app-thin">
        {lines.map((line, index) => (
          <div key={index} className="flex px-3">
            {lineNumbers && <span aria-hidden="true" className="mr-4 w-5 shrink-0 select-none text-right text-muted-foreground/50">{index + 1}</span>}
            <code className="whitespace-pre">{line || ' '}</code>
          </div>
        ))}
      </pre>
    </div>
  )
}

export interface TerminalLine {
  /** command 带 $ 提示符 · output 普通输出 · 其余为带色输出 */
  kind?: 'command' | 'output' | 'success' | 'error' | 'warning' | 'info' | 'muted'
  text: string
}

/** 程序输出用 ANSI 色（--terminal-*，与 xterm 同一套） */
const TERMINAL_COLOR: Record<NonNullable<TerminalLine['kind']>, string> = {
  command: 'text-terminal-foreground',
  output: 'text-terminal-foreground',
  success: 'text-terminal-green',
  error: 'text-terminal-red',
  warning: 'text-terminal-yellow',
  info: 'text-terminal-blue',
  muted: 'text-terminal-bright-black',
}

/** 终端输出：全站唯一的常驻深色面，配色与 xterm 主题一致，像「窗口中的窗口」 */
export function TerminalBlock({ title, status, lines, className }: { title?: ReactNode; status?: ReactNode; lines: TerminalLine[]; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-lg bg-terminal', className)}>
      {(title || status) && (
        <div className="flex h-8 items-center justify-between gap-3 border-b border-terminal-border px-3 text-[11px] text-terminal-muted-foreground">
          <span className="truncate font-mono">{title}</span>
          {status}
        </div>
      )}
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-5 scrollbar-app-thin">
        {lines.map((line, index) => (
          <div key={index} className={cn('whitespace-pre', TERMINAL_COLOR[line.kind ?? 'output'])}>
            {line.kind === 'command' && <span className="text-terminal-bright-black">$ </span>}
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  )
}

/** 可复制的指令（「把这句话发给你的 Agent」）：正文墨色，右上角带文字的复制按钮 */
export function PromptBlock({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('relative rounded-lg border border-border/70 bg-foreground/[0.02] py-2.5 pl-3 pr-[72px] text-[13px] leading-relaxed text-foreground/90', className)}>
      <p className="whitespace-pre-wrap break-words">{text}</p>
      <CopyButton value={text} display="text" size="xs" variant="ghost" className="absolute right-1.5 top-2" />
    </div>
  )
}
