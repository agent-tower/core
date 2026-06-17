import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  GitGraph, Loader2, FileCode2, ChevronRight, ChevronDown,
  ArrowLeft, Search, History, FolderOpen, Folder,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n, translate } from '@/lib/i18n'
import {
  useGitChanges, useGitDiff, useGitCommitFiles, useGitCommitDiff,
  type GitChangeEntry, type GitLogResponse, type GitLogEntry,
} from '@/hooks/use-git'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from '@/hooks/query-keys'
import { GitStatusBar } from './GitStatusBar'

// 与 HistoryView 保持一致：二者共享 queryKeys.git.log 缓存，分页参数必须相同
const PAGE_SIZE = 50
const AUTO_COLLAPSE_LINES = 400

type DiffType = 'uncommitted' | 'committed'

/** 卡片数据源：工作区 diff 或单 commit diff */
type CardSource =
  | { kind: 'working'; diffType: DiffType }
  | { kind: 'commit'; hash: string }

/** 视图模式状态机：overview ⇄ commit-detail */
type ViewMode =
  | { kind: 'overview' }
  | { kind: 'commit'; commit: GitLogEntry }

const STATUS_COLOR_MAP: Record<string, string> = {
  M: 'text-amber-600 border-amber-200 bg-amber-50',
  A: 'text-emerald-600 border-emerald-200 bg-emerald-50',
  D: 'text-red-600 border-red-200 bg-red-50',
  R: 'text-blue-600 border-blue-200 bg-blue-50',
}

const STATUS_DOT_MAP: Record<string, string> = {
  M: 'bg-amber-500',
  A: 'bg-emerald-500',
  D: 'bg-red-500',
  R: 'bg-blue-500',
}

function basename(p: string) {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function dirname(p: string) {
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : ''
}

function timeAgo(ts: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - ts
  if (diff < 60) return translate('{count}s ago', { count: diff })
  if (diff < 3600) return translate('{count}m ago', { count: Math.floor(diff / 60) })
  if (diff < 86400) return translate('{count}h ago', { count: Math.floor(diff / 3600) })
  if (diff < 604800) return translate('{count}d ago', { count: Math.floor(diff / 86400) })
  return new Date(ts * 1000).toLocaleDateString()
}

function cardKeyOf(source: CardSource, path: string) {
  return source.kind === 'working' ? `${source.diffType}:${path}` : `${source.hash}:${path}`
}

/** +n -n 增删统计 */
const DiffStat: React.FC<{ additions?: number; deletions?: number; className?: string }> = ({
  additions, deletions, className,
}) => {
  if (additions === undefined && deletions === undefined) return null
  return (
    <span className={cn('flex items-center gap-1 font-mono text-[11px] shrink-0', className)}>
      {additions !== undefined && additions > 0 && <span className="text-emerald-600">+{additions}</span>}
      {deletions !== undefined && deletions > 0 && <span className="text-red-600">-{deletions}</span>}
      {(additions ?? 0) === 0 && (deletions ?? 0) === 0 && <span className="text-muted-foreground/60">0</span>}
    </span>
  )
}

// ============================================================
// Diff 渲染
// ============================================================

const DiffLine: React.FC<{ line: string; lineNum: number }> = ({ line, lineNum }) => {
  let bgClass = ''
  let textClass = 'text-foreground/90'

  if (line.startsWith('+') && !line.startsWith('+++')) {
    bgClass = 'bg-success/10'
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    bgClass = 'bg-destructive/10'
  } else if (line.startsWith('@@')) {
    bgClass = 'bg-info/5'
    textClass = 'text-info'
  } else if (line.startsWith('diff ') || line.startsWith('index ')) {
    textClass = 'text-muted-foreground/70'
  }

  return (
    <div className={cn('flex', bgClass)}>
      <span className="w-10 shrink-0 text-right pr-2 text-muted-foreground/60 select-none border-r border-border/60">
        {lineNum}
      </span>
      <span className={cn('pl-2 whitespace-pre', textClass)}>{line}</span>
    </div>
  )
}

/** diff 文本主体：超大 diff 默认截断，可展开 */
const DiffContent: React.FC<{ diff: string }> = ({ diff }) => {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const lines = useMemo(() => diff.split('\n'), [diff])

  if (!diff.trim()) {
    return (
      <div className="py-6 text-center text-muted-foreground/70 text-xs">
        {t('没有可显示的差异内容')}
      </div>
    )
  }

  const truncated = !expanded && lines.length > AUTO_COLLAPSE_LINES
  const visibleLines = truncated ? lines.slice(0, AUTO_COLLAPSE_LINES) : lines

  return (
    <div className="overflow-x-auto scrollbar-app-thin font-mono text-xs leading-5">
      {visibleLines.map((line, i) => (
        <DiffLine key={i} line={line} lineNum={i + 1} />
      ))}
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full py-2 text-xs text-info hover:bg-info/5 transition-colors"
        >
          {t('还有 {count} 行变更被折叠，点击展开全部', { count: lines.length - AUTO_COLLAPSE_LINES })}
        </button>
      )}
    </div>
  )
}

/** 工作区文件 diff（懒加载） */
const WorkingDiffBody: React.FC<{
  workingDir: string; path: string; diffType: DiffType; enabled: boolean
}> = ({ workingDir, path, diffType, enabled }) => {
  const { t } = useI18n()
  const { data, isLoading, isError } = useGitDiff(workingDir, enabled ? path : null, diffType)

  if (!enabled || isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 size={14} className="animate-spin mr-2" />
        <span className="text-xs">{t('正在加载差异...')}</span>
      </div>
    )
  }
  if (isError) {
    return <div className="py-6 text-center text-destructive text-xs">{t('差异加载失败')}</div>
  }
  return <DiffContent diff={data?.diff || ''} />
}

/** 单 commit 文件 diff（懒加载） */
const CommitDiffBody: React.FC<{
  workingDir: string; hash: string; path: string; enabled: boolean
}> = ({ workingDir, hash, path, enabled }) => {
  const { t } = useI18n()
  const { data, isLoading, isError } = useGitCommitDiff(workingDir, enabled ? hash : null, enabled ? path : null)

  if (!enabled || isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 size={14} className="animate-spin mr-2" />
        <span className="text-xs">{t('正在加载差异...')}</span>
      </div>
    )
  }
  if (isError) {
    return <div className="py-6 text-center text-destructive text-xs">{t('差异加载失败')}</div>
  }
  return <DiffContent diff={data?.diff || ''} />
}

// ============================================================
// Diff 卡片
// ============================================================

const DiffCard: React.FC<{
  entry: GitChangeEntry
  source: CardSource
  workingDir: string
  flash: boolean
  registerNode: (key: string, node: HTMLElement | null) => void
}> = ({ entry, source, workingDir, flash, registerNode }) => {
  const [collapsed, setCollapsed] = useState(false)
  const [shouldLoad, setShouldLoad] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const key = cardKeyOf(source, entry.path)

  // 注册节点供树导航定位
  useEffect(() => {
    registerNode(key, ref.current)
    return () => registerNode(key, null)
  }, [key, registerNode])

  // 进入视口（含 300px 预加载边距）才请求 diff，一次性
  useEffect(() => {
    const node = ref.current
    if (!node || shouldLoad) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShouldLoad(true)
          observer.disconnect()
        }
      },
      { rootMargin: '300px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [shouldLoad])

  const colorClass = STATUS_COLOR_MAP[entry.status] || STATUS_COLOR_MAP.M
  const dir = dirname(entry.path)

  return (
    <div
      ref={ref}
      data-card-key={key}
      className={cn(
        'rounded-md border border-border bg-background overflow-hidden transition-shadow',
        flash && 'ring-2 ring-info/40',
      )}
    >
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/40 hover:bg-muted/70 transition-colors text-left"
      >
        {collapsed
          ? <ChevronRight size={13} className="text-muted-foreground/70 shrink-0" />
          : <ChevronDown size={13} className="text-muted-foreground/70 shrink-0" />}
        <span className={cn('w-4 h-4 flex items-center justify-center text-[11px] font-semibold border rounded-sm shrink-0', colorClass)}>
          {entry.status}
        </span>
        <span className="text-xs font-medium text-foreground truncate">{basename(entry.path)}</span>
        {dir && <span className="text-[11px] text-muted-foreground/70 truncate">{dir}</span>}
        <span className="ml-auto" />
        <DiffStat additions={entry.additions} deletions={entry.deletions} />
      </button>
      {!collapsed && (
        <div className="border-t border-border/60">
          {source.kind === 'working' ? (
            <WorkingDiffBody workingDir={workingDir} path={entry.path} diffType={source.diffType} enabled={shouldLoad} />
          ) : (
            <CommitDiffBody workingDir={workingDir} hash={source.hash} path={entry.path} enabled={shouldLoad} />
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================
// 右侧栏：文件树
// ============================================================

type TreeEntry = GitChangeEntry & { cardKey: string }

interface TreeDir {
  name: string
  path: string
  dirs: Map<string, TreeDir>
  files: TreeEntry[]
}

function buildTree(entries: TreeEntry[]): TreeDir {
  const root: TreeDir = { name: '', path: '', dirs: new Map(), files: [] }
  for (const entry of entries) {
    const segments = entry.path.split('/')
    let node = root
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!
      if (!node.dirs.has(seg)) {
        node.dirs.set(seg, {
          name: seg,
          path: node.path ? `${node.path}/${seg}` : seg,
          dirs: new Map(),
          files: [],
        })
      }
      node = node.dirs.get(seg)!
    }
    node.files.push(entry)
  }
  return compressTree(root)
}

/** 压缩单链目录：a/b/c 只有一个子目录时合并显示 */
function compressTree(node: TreeDir): TreeDir {
  const dirs = new Map<string, TreeDir>()
  for (const child of node.dirs.values()) {
    let current = compressTree(child)
    while (current.dirs.size === 1 && current.files.length === 0) {
      const only = [...current.dirs.values()][0]!
      current = { ...only, name: `${current.name}/${only.name}` }
    }
    dirs.set(current.name, current)
  }
  return { ...node, dirs }
}

const TreeDirRow: React.FC<{
  dir: TreeDir
  depth: number
  activeKey: string | null
  onSelect: (entry: TreeEntry) => void
}> = ({ dir, depth, activeKey, onSelect }) => {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 w-full px-2 py-1 rounded-sm hover:bg-muted/60 text-left"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {open
          ? <FolderOpen size={12} className="text-muted-foreground/70 shrink-0" />
          : <Folder size={12} className="text-muted-foreground/70 shrink-0" />}
        <span className="text-[11px] text-muted-foreground truncate">{dir.name}</span>
      </button>
      {open && <TreeChildren node={dir} depth={depth + 1} activeKey={activeKey} onSelect={onSelect} />}
    </div>
  )
}

const TreeChildren: React.FC<{
  node: TreeDir
  depth: number
  activeKey: string | null
  onSelect: (entry: TreeEntry) => void
}> = ({ node, depth, activeKey, onSelect }) => (
  <>
    {[...node.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((dir) => (
        <TreeDirRow key={dir.path} dir={dir} depth={depth} activeKey={activeKey} onSelect={onSelect} />
      ))}
    {node.files
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((entry) => {
        const active = activeKey === entry.cardKey
        return (
          <button
            key={entry.cardKey}
            type="button"
            onClick={() => onSelect(entry)}
            className={cn(
              'flex items-center gap-1.5 w-full px-2 py-1 rounded-sm text-left',
              active ? 'bg-muted' : 'hover:bg-muted/60',
            )}
            style={{ paddingLeft: 8 + depth * 12 }}
            title={entry.path}
          >
            <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', STATUS_DOT_MAP[entry.status] || STATUS_DOT_MAP.M)} />
            <span className={cn('text-xs truncate', active ? 'text-foreground font-medium' : 'text-foreground/90')}>
              {basename(entry.path)}
            </span>
          </button>
        )
      })}
  </>
)

// ============================================================
// 右侧栏：提交时间线
// ============================================================

const CommitTimeline: React.FC<{
  workingDir: string
  selectedHash: string | null
  onSelectCommit: (commit: GitLogEntry) => void
}> = ({ workingDir, selectedHash, onSelectCommit }) => {
  const { t } = useI18n()
  const {
    data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: queryKeys.git.log(workingDir),
    queryFn: ({ pageParam = 0 }) =>
      apiClient.get<GitLogResponse>('/git/log', {
        params: { workingDir, limit: String(PAGE_SIZE), skip: String(pageParam) },
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.commits.length < PAGE_SIZE ? undefined : allPages.length * PAGE_SIZE,
  })

  const commits = data?.pages.flatMap((p) => p.commits) || []

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 text-muted-foreground/70 text-[11px]">
        <Loader2 size={11} className="animate-spin" />
        <span>{t('正在加载提交记录...')}</span>
      </div>
    )
  }
  if (commits.length === 0) {
    return <div className="px-3 py-2 text-[11px] text-muted-foreground/60">{t('暂无提交记录')}</div>
  }

  return (
    <div className="space-y-px px-1.5 pb-1.5">
      {commits.map((commit) => {
        const active = selectedHash === commit.hash
        return (
          <button
            key={commit.hash}
            type="button"
            onClick={() => onSelectCommit(commit)}
            className={cn(
              'flex items-start gap-1.5 w-full px-1.5 py-1 rounded-sm text-left group',
              active ? 'bg-muted' : 'hover:bg-muted/60',
            )}
            title={commit.message}
          >
            <span className={cn(
              'w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 transition-colors',
              active ? 'bg-brand' : 'bg-border group-hover:bg-muted-foreground/60',
            )} />
            <span className="flex-1 min-w-0">
              <span className={cn('block text-xs truncate', active ? 'text-foreground font-medium' : 'text-foreground/90')}>
                {commit.message}
              </span>
              <span className="block text-[11px] text-muted-foreground/70 truncate">
                <span className="font-mono">{commit.shortHash}</span>
                {' · '}{commit.author}{' · '}{timeAgo(commit.timestamp)}
              </span>
            </span>
          </button>
        )
      })}
      {hasNextPage && (
        <button
          type="button"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="w-full py-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-sm transition-colors flex items-center justify-center gap-1.5"
        >
          {isFetchingNextPage
            ? <><Loader2 size={11} className="animate-spin" /> {t('正在加载...')}</>
            : t('加载更多提交')}
        </button>
      )}
    </div>
  )
}

// ============================================================
// 主组件
// ============================================================

export interface ReviewViewProps {
  workingDir?: string
  workspaceId?: string
  branchName?: string
  targetBranch?: string
  commitMessage?: string | null
  canRunGitOperations?: boolean
  onRefreshCommitMessage?: () => void | Promise<unknown>
  onConflict?: (details?: import('./GitOperationsDialog').ConflictDetails) => void
  onResolveConflicts?: () => void
}

export const ReviewView: React.FC<ReviewViewProps> = ({
  workingDir,
  workspaceId,
  branchName,
  targetBranch,
  commitMessage,
  canRunGitOperations,
  onRefreshCommitMessage,
  onConflict,
  onResolveConflicts,
}) => {
  const { t } = useI18n()
  const [viewMode, setViewMode] = useState<ViewMode>({ kind: 'overview' })
  const [filter, setFilter] = useState('')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [flashKey, setFlashKey] = useState<string | null>(null)

  const { data: changesData, isLoading: changesLoading, isError: changesError } = useGitChanges(workingDir)
  const commitHash = viewMode.kind === 'commit' ? viewMode.commit.hash : null
  const { data: commitFilesData, isLoading: commitFilesLoading } = useGitCommitFiles(workingDir, commitHash)

  const cardNodes = useRef(new Map<string, HTMLElement>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const registerNode = useCallback((key: string, node: HTMLElement | null) => {
    if (node) cardNodes.current.set(key, node)
    else cardNodes.current.delete(key)
  }, [])

  // 数据整理：当前模式下的卡片条目
  const { uncommitted, committed, commitFiles } = useMemo(() => {
    const matches = (e: GitChangeEntry) =>
      !filter.trim() || e.path.toLowerCase().includes(filter.trim().toLowerCase())

    if (viewMode.kind === 'commit') {
      const source: CardSource = { kind: 'commit', hash: viewMode.commit.hash }
      const files: TreeEntry[] = (commitFilesData?.files || [])
        .filter(matches)
        .map((e) => ({ ...e, cardKey: cardKeyOf(source, e.path) }))
      return { uncommitted: [] as TreeEntry[], committed: [] as TreeEntry[], commitFiles: files }
    }

    const un: TreeEntry[] = (changesData?.uncommitted || [])
      .filter(matches)
      .map((e) => ({ ...e, cardKey: cardKeyOf({ kind: 'working', diffType: 'uncommitted' }, e.path) }))
    const co: TreeEntry[] = (changesData?.committed || [])
      .filter(matches)
      .map((e) => ({ ...e, cardKey: cardKeyOf({ kind: 'working', diffType: 'committed' }, e.path) }))
    return { uncommitted: un, committed: co, commitFiles: [] as TreeEntry[] }
  }, [viewMode, changesData, commitFilesData, filter])

  const allEntries = viewMode.kind === 'commit' ? commitFiles : [...uncommitted, ...committed]
  const tree = useMemo(() => buildTree(allEntries), [allEntries])

  const totals = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const e of allEntries) {
      additions += e.additions ?? 0
      deletions += e.deletions ?? 0
    }
    return { additions, deletions, files: allEntries.length }
  }, [allEntries])

  // scroll-spy：滚动时取视口顶部附近的卡片高亮树节点
  const handleScroll = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    const containerTop = container.getBoundingClientRect().top
    let current: string | null = null
    let bestOffset = Number.NEGATIVE_INFINITY
    for (const [key, node] of cardNodes.current) {
      const offset = node.getBoundingClientRect().top - containerTop
      if (offset <= 48 && offset > bestOffset) {
        bestOffset = offset
        current = key
      }
    }
    if (!current) {
      // 没有卡片越过顶线时取第一张
      let firstKey: string | null = null
      let firstOffset = Number.POSITIVE_INFINITY
      for (const [key, node] of cardNodes.current) {
        const offset = node.getBoundingClientRect().top - containerTop
        if (offset < firstOffset) {
          firstOffset = offset
          firstKey = key
        }
      }
      current = firstKey
    }
    setActiveKey(current)
  }, [])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(handleScroll)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [handleScroll])

  // 树节点点击 → 滚动定位 + 闪烁高亮
  const scrollToCard = useCallback((entry: TreeEntry) => {
    const node = cardNodes.current.get(entry.cardKey)
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveKey(entry.cardKey)
    setFlashKey(entry.cardKey)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlashKey(null), 1200)
  }, [])

  const enterCommit = useCallback((commit: GitLogEntry) => {
    setViewMode((prev) =>
      prev.kind === 'commit' && prev.commit.hash === commit.hash
        ? { kind: 'overview' }
        : { kind: 'commit', commit },
    )
    setFilter('')
    setActiveKey(null)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [])

  const backToOverview = useCallback(() => {
    setViewMode({ kind: 'overview' })
    setFilter('')
    setActiveKey(null)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [])

  if (!workingDir) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm bg-background h-full">
        {t('未选择工作区')}
      </div>
    )
  }

  const showGitBar = canRunGitOperations && workspaceId && branchName && targetBranch
  const isLoadingMain = viewMode.kind === 'commit' ? commitFilesLoading : changesLoading

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-background">
      {showGitBar && onConflict && onResolveConflicts && (
        <GitStatusBar
          workspaceId={workspaceId}
          branchName={branchName}
          targetBranch={targetBranch}
          commitMessage={commitMessage}
          committedFileCount={changesData?.committed?.length}
          onRefreshCommitMessage={onRefreshCommitMessage}
          onConflict={onConflict}
          onResolveConflicts={onResolveConflicts}
        />
      )}

      {/* 统计条 / 面包屑 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 shrink-0 min-h-[37px]">
        {viewMode.kind === 'overview' ? (
          <>
            <GitGraph size={14} className="text-muted-foreground shrink-0" />
            <span className="text-xs font-semibold text-foreground">{t('代码审查')}</span>
            <span className="text-[11px] text-muted-foreground">
              {t('{count} 个文件', { count: totals.files })}
            </span>
            <DiffStat additions={totals.additions} deletions={totals.deletions} />
            {branchName && targetBranch && (
              <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground/70 font-mono truncate">
                <span className="truncate">{branchName}</span>
                <ArrowLeft size={10} className="rotate-180 shrink-0" />
                <span className="truncate">{targetBranch}</span>
              </span>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={backToOverview}
              className="flex items-center gap-1 px-1.5 py-0.5 -ml-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
            >
              <ArrowLeft size={12} />
              {t('全部变更')}
            </button>
            <span className="text-muted-foreground/40 text-xs">/</span>
            <span className="text-[11px] font-mono text-muted-foreground shrink-0">{viewMode.commit.shortHash}</span>
            <span className="text-xs text-foreground truncate">{viewMode.commit.message}</span>
            <DiffStat className="ml-auto" additions={totals.additions} deletions={totals.deletions} />
          </>
        )}
      </div>

      {/* 主区 + 右侧栏 */}
      <div className="flex flex-1 min-h-0">
        {/* diff 卡片流 */}
        <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto scrollbar-app-thin">
          {isLoadingMain ? (
            <div className="p-3 space-y-3">
              {[0, 1].map((i) => (
                <div key={i} className="rounded-md border border-border overflow-hidden">
                  <div className="h-8 bg-muted/60 animate-pulse" />
                  <div className="p-3 space-y-2">
                    <div className="h-3 w-2/3 bg-muted animate-pulse rounded-sm" />
                    <div className="h-3 w-1/2 bg-muted animate-pulse rounded-sm" />
                    <div className="h-3 w-3/4 bg-muted animate-pulse rounded-sm" />
                  </div>
                </div>
              ))}
            </div>
          ) : changesError && viewMode.kind === 'overview' ? (
            <div className="flex-1 flex items-center justify-center py-16 text-destructive text-sm">
              {t('变更加载失败')}
            </div>
          ) : allEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground/60">
              <FileCode2 size={28} className="mb-2" />
              <span className="text-xs">
                {filter.trim()
                  ? t('没有匹配筛选条件的文件')
                  : viewMode.kind === 'commit'
                    ? t('该提交没有文件变更')
                    : t('没有待审查的变更')}
              </span>
            </div>
          ) : viewMode.kind === 'commit' ? (
            <div className="p-3 space-y-3">
              {commitFiles.map((entry) => (
                <DiffCard
                  key={entry.cardKey}
                  entry={entry}
                  source={{ kind: 'commit', hash: viewMode.commit.hash }}
                  workingDir={workingDir}
                  flash={flashKey === entry.cardKey}
                  registerNode={registerNode}
                />
              ))}
            </div>
          ) : (
            <div className="p-3 space-y-4">
              {uncommitted.length > 0 && (
                <section>
                  <div className="sticky top-0 z-10 -mx-3 px-5 py-1.5 bg-background/95 backdrop-blur-sm">
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('未提交')}
                    </span>
                    <span className="ml-2 text-[11px] text-muted-foreground/70">{uncommitted.length}</span>
                  </div>
                  <div className="space-y-3 mt-1">
                    {uncommitted.map((entry) => (
                      <DiffCard
                        key={entry.cardKey}
                        entry={entry}
                        source={{ kind: 'working', diffType: 'uncommitted' }}
                        workingDir={workingDir}
                        flash={flashKey === entry.cardKey}
                        registerNode={registerNode}
                      />
                    ))}
                  </div>
                </section>
              )}
              {committed.length > 0 && (
                <section>
                  <div className="sticky top-0 z-10 -mx-3 px-5 py-1.5 bg-background/95 backdrop-blur-sm">
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('已提交')}
                    </span>
                    <span className="ml-2 text-[11px] text-muted-foreground/70">{committed.length}</span>
                  </div>
                  <div className="space-y-3 mt-1">
                    {committed.map((entry) => (
                      <DiffCard
                        key={entry.cardKey}
                        entry={entry}
                        source={{ kind: 'working', diffType: 'committed' }}
                        workingDir={workingDir}
                        flash={flashKey === entry.cardKey}
                        registerNode={registerNode}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>

        {/* 右侧栏：筛选 + 文件树 + 提交时间线 */}
        <aside
          className="shrink-0 border-l border-border flex flex-col min-h-0"
          style={{ width: 'clamp(15rem, 24%, 22rem)' }}
        >
          <div className="p-2 shrink-0">
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('筛选文件...')}
                className="w-full pl-6.5 pr-2 py-1.5 rounded-md border border-input bg-background text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto scrollbar-app-thin px-1.5 pb-1.5 min-h-0">
            {allEntries.length === 0 ? (
              <div className="px-2 py-3 text-[11px] text-muted-foreground/60">
                {filter.trim() ? t('无匹配文件') : t('暂无变更文件')}
              </div>
            ) : (
              <TreeChildren node={tree} depth={0} activeKey={activeKey} onSelect={scrollToCard} />
            )}
          </div>

          <div className="shrink-0 border-t border-border/60 max-h-[40%] flex flex-col min-h-0">
            <div className="flex items-center gap-1.5 px-3 py-2 shrink-0">
              <History size={12} className="text-muted-foreground" />
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                {t('提交记录')}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-app-thin min-h-0">
              <CommitTimeline
                workingDir={workingDir}
                selectedHash={commitHash}
                onSelectCommit={enterCommit}
              />
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
