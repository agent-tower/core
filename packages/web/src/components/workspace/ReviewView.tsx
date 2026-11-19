import React, { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  GitGraph, FileCode2, ChevronRight, ChevronDown,
  ArrowLeft, History, FolderOpen, Folder,
} from 'lucide-react'
import { DiffStat as BaseDiffStat, FileStatusBadge, SearchField, Spinner, TONE_DOT, fileChangeTone } from '@/design-system'
import { cn } from '@/lib/utils'
import { useI18n, translate } from '@/lib/i18n'
import {
  useGitChanges, useGitDiff, useGitCommitFiles, useGitCommitDiff, useGitLogPages,
  type GitChangeEntry, type GitLogEntry,
} from '@/hooks/use-git'
import { GitStatusBar } from './GitStatusBar'
import { DiffLine } from './DiffLine'
import { FileDiffNotice } from './FileDiffNotice'
import {
  AUTO_COLLAPSE_LINES, ROW_GAP, SECTION_HEIGHT, buildReviewRows, currentReviewCard,
  diffQueryKey, estimateDiffBody, estimateReviewRow, filterReviewRows, type CardRow, type CardState, type DiffAnswer, type DiffType,
} from './review-rows'

const DEFAULT_CARD_STATE: CardState = {}

type ViewMode =
  | { kind: 'overview' }
  | { kind: 'commit'; commit: GitLogEntry }

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

const DiffStat: React.FC<{ additions?: number; deletions?: number; className?: string }> = ({
  additions, deletions, className,
}) => {
  if (additions === undefined && deletions === undefined) return null
  return <BaseDiffStat additions={additions} deletions={deletions} className={className} />
}

interface ExpansionProps {
  expanded: boolean
  onExpand: () => void
}

const DiffContent = React.memo(function DiffContent({ diff, expanded, onExpand }: ExpansionProps & { diff: string }) {
  const { t } = useI18n()
  const lines = useMemo(() => diff.split('\n'), [diff])

  if (!diff.trim()) {
    return (
      <div className="py-6 text-center text-muted-foreground text-xs">
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
          onClick={onExpand}
          className="w-full py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {t('还有 {count} 行变更被折叠，点击展开全部', { count: lines.length - AUTO_COLLAPSE_LINES })}
        </button>
      )}
    </div>
  )
})

function DiffLoading({ height }: { height: number }) {
  const { t } = useI18n()
  return (
    <div style={{ height }}>
      <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
        <Spinner size="sm" />
        <span className="text-xs">{t('正在加载差异...')}</span>
      </div>
    </div>
  )
}

const WorkingDiffBody: React.FC<ExpansionProps & {
  workingDir: string; path: string; diffType: DiffType; token?: string
  force: boolean; onForce: () => void; loadingHeight: number
}> = ({ workingDir, path, diffType, token, force, onForce, loadingHeight, ...expansion }) => {
  const { t } = useI18n()
  const { data, isLoading, isError, isFetching } = useGitDiff(workingDir, path, diffType, token, { force })

  if (isLoading) return <DiffLoading height={loadingHeight} />
  if (isError) {
    return <div className="py-6 text-center text-destructive-ink text-xs">{t('差异加载失败')}</div>
  }
  if (data && data.kind !== 'text') {
    return <FileDiffNotice answer={data} loading={isFetching} onLoadAnyway={onForce} />
  }
  return <DiffContent diff={data?.diff ?? ''} {...expansion} />
}

const CommitDiffBody: React.FC<ExpansionProps & {
  workingDir: string; hash: string; path: string; loadingHeight: number
}> = ({ workingDir, hash, path, loadingHeight, ...expansion }) => {
  const { t } = useI18n()
  const { data, isLoading, isError } = useGitCommitDiff(workingDir, hash, path)

  if (isLoading) return <DiffLoading height={loadingHeight} />
  if (isError) {
    return <div className="py-6 text-center text-destructive-ink text-xs">{t('差异加载失败')}</div>
  }
  return <DiffContent diff={data?.diff || ''} {...expansion} />
}

interface DiffCardProps {
  workingDir: string
  row: CardRow
  state: CardState
  onStateChange: (key: string, patch: CardState) => void
  mayLoad: boolean
  flash: boolean
}

function DiffBody({ workingDir, row, state, onStateChange, mayLoad }: Omit<DiffCardProps, 'flash'>) {
  const client = useQueryClient()
  const { source, entry, key } = row
  const force = state.force === true
  const cached = client.getQueryData(diffQueryKey(workingDir, row, force))
  // Keep observing an admitted request as scrolling starts. A new version can wait
  // with its previous answer on screen until this window settles.
  const [request, setRequest] = useState<{ token?: string; force: boolean } | null>(null)
  if ((mayLoad || cached !== undefined) && (!request || request.token !== entry.token || request.force !== force)) {
    setRequest({ token: entry.token, force })
  }
  const onExpand = useCallback(() => onStateChange(key, { expanded: true }), [key, onStateChange])
  const loadingHeight = estimateDiffBody(entry)
  if (!request) return <DiffLoading height={loadingHeight} />
  const expansion = { expanded: !!state.expanded, onExpand }
  return source.kind === 'working' ? (
    <WorkingDiffBody workingDir={workingDir} path={entry.path} diffType={source.diffType}
      token={request.token} force={request.force} onForce={() => onStateChange(key, { force: true })}
      loadingHeight={loadingHeight} {...expansion} />
  ) : (
    <CommitDiffBody workingDir={workingDir} path={entry.path} hash={source.hash} loadingHeight={loadingHeight} {...expansion} />
  )
}

export const DiffCard = React.memo(function DiffCard(props: DiffCardProps) {
  const { row: { entry, key }, state: { collapsed }, onStateChange, flash } = props
  const dir = dirname(entry.path)

  return (
    <div
      data-card-key={key}
      className={cn(
        'rounded-md border border-border bg-background overflow-hidden transition-shadow',
        flash && 'ring-2 ring-info/40',
      )}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => onStateChange(key, { collapsed: !collapsed })}
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/40 hover:bg-muted/70 transition-colors text-left"
      >
        {collapsed
          ? <ChevronRight size={13} className="text-muted-foreground/70 shrink-0" />
          : <ChevronDown size={13} className="text-muted-foreground/70 shrink-0" />}
        <FileStatusBadge status={entry.status} />
        <span className="text-xs font-medium text-foreground truncate">{basename(entry.path)}</span>
        {dir && <span className="font-mono text-[11px] text-muted-foreground truncate">{dir}</span>}
        <span className="ml-auto" />
        <DiffStat additions={entry.additions} deletions={entry.deletions} />
      </button>
      {!collapsed && (
        <div className="border-t border-border/60">
          <DiffBody {...props} />
        </div>
      )}
    </div>
  )
})

// File tree
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

/** Show a chain of single-child directories as one path. */
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

const TreeChildren = React.memo(function TreeChildren({ node, depth, activeKey, onSelect }: {
  node: TreeDir
  depth: number
  activeKey: string | null
  onSelect: (entry: TreeEntry) => void
}) {
  return (
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
              aria-current={active || undefined}
              type="button"
              onClick={() => onSelect(entry)}
              className={cn(
                'flex items-center gap-1.5 w-full px-2 py-1 rounded-sm text-left',
                active ? 'bg-muted' : 'hover:bg-muted/60',
              )}
              style={{ paddingLeft: 8 + depth * 12 }}
              title={entry.path}
            >
              <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', TONE_DOT[fileChangeTone(entry.status)])} />
              <span className={cn('text-xs truncate', active ? 'text-foreground font-medium' : 'text-foreground/90')}>
                {basename(entry.path)}
              </span>
            </button>
          )
        })}
    </>
  )
})

const CommitTimeline: React.FC<{
  workingDir: string
  selectedHash: string | null
  onSelectCommit: (commit: GitLogEntry) => void
}> = ({ workingDir, selectedHash, onSelectCommit }) => {
  const { t } = useI18n()
  // Shares the history cache with HistoryView, so it uses the same paged query.
  const {
    data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useGitLogPages(workingDir)

  const commits = data?.pages.flatMap((p) => p.commits) || []

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 text-muted-foreground text-xs">
        <Spinner size="xs" />
        <span>{t('正在加载提交记录...')}</span>
      </div>
    )
  }
  if (commits.length === 0) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">{t('暂无提交记录')}</div>
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
              active ? 'bg-primary' : 'bg-border group-hover:bg-muted-foreground/60',
            )} />
            <span className="flex-1 min-w-0">
              <span className={cn('block text-xs truncate', active ? 'text-foreground font-medium' : 'text-foreground/90')}>
                {commit.message}
              </span>
              <span className="block text-[11px] text-muted-foreground truncate">
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
          className="w-full py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-sm transition-colors flex items-center justify-center gap-1.5"
        >
          {isFetchingNextPage
            ? <><Spinner size="xs" /> {t('正在加载...')}</>
            : t('加载更多提交')}
        </button>
      )}
    </div>
  )
}

function SectionLabel({ section, count }: { section: DiffType; count: number }) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-2 px-5 bg-background/95 backdrop-blur-sm" style={{ height: SECTION_HEIGHT }}>
      <span className="text-xs font-medium text-muted-foreground">{section === 'uncommitted' ? t('未提交') : t('已提交')}</span>
      <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
    </div>
  )
}

export interface ReviewViewProps {
  projectId?: string
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
  projectId,
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

  const client = useQueryClient()
  const scrollRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [cardStates, setCardStates] = useState(() => new Map<string, CardState>())
  const listedRows = useMemo(() => buildReviewRows(changesData, commitHash, commitFilesData?.files),
    [changesData, commitHash, commitFilesData])
  const rows = useMemo(() => filterReviewRows(listedRows, filter), [listedRows, filter])
  const indexByKey = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows])
  const allEntries = useMemo(() => rows.flatMap(row => row.kind === 'card' ? [{ ...row.entry, cardKey: row.key }] : []), [rows])
  const tree = useMemo(() => buildTree(allEntries), [allEntries])

  useEffect(() => {
    const listed = new Set(listedRows.map(row => row.key))
    setCardStates(previous => {
      if ([...previous.keys()].every(key => listed.has(key))) return previous
      return new Map([...previous].filter(([key]) => listed.has(key)))
    })
  }, [listedRows])
  const updateCard = useCallback((key: string, patch: CardState) => {
    setCardStates(previous => new Map(previous).set(key, { ...previous.get(key), ...patch }))
  }, [])

  const totals = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const e of allEntries) {
      additions += e.additions ?? 0
      deletions += e.deletions ?? 0
    }
    return { additions, deletions, files: allEntries.length }
  }, [allEntries])

  const labelHeight = commitHash ? 0 : SECTION_HEIGHT
  // Freeze estimates for this layout. A placeholder that exactly matches its estimate
  // has no measured-size override in TanStack Virtual. Reading a newly cached answer
  // during layout would move later rows before ResizeObserver could report that delta.
  const estimatedSizes = useMemo(() => rows.map(row => {
    if (row.kind === 'section') return SECTION_HEIGHT
    const state = cardStates.get(row.key)
    const answer = client.getQueryData<DiffAnswer>(diffQueryKey(workingDir ?? '', row, state?.force))
    return estimateReviewRow(row, state, answer)
  }), [rows, cardStates, client, workingDir])
  const pendingResize = useRef<{ top: number; delta: number } | null>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: useCallback((index: number) => rows[index].key, [rows]),
    estimateSize: index => estimatedSizes[index],
    gap: ROW_GAP,
    overscan: 2,
    scrollPaddingStart: labelHeight,
    isScrollingResetDelay: 150,
  })
  // Native scroll events can arrive after a resize. Accumulate against the live
  // viewport, incorporating prior rows in the same ResizeObserver delivery.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
    const top = instance.scrollElement?.scrollTop ?? 0
    const pendingDelta = pendingResize.current?.delta ?? 0
    const adjustedTop = top + pendingDelta
    const atTop = instance.getVirtualItemForOffset(adjustedTop)
    if (atTop && (item.index < atTop.index || (item.index === atTop.index && atTop.start < adjustedTop))) {
      pendingResize.current = { top, delta: pendingDelta + delta }
      // Calculate the next virtual window at the corrected offset as well. An
      // intermediate window at the old offset would mount and fetch unrelated cards.
      instance.scrollOffset = Math.max(0, adjustedTop + delta)
    }
    // Apply the correction after the track height and row positions reach the DOM.
    return false
  }
  const items = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()
  const lastStart = virtualizer.measurementsCache[rows.length - 1]?.start ?? 0
  useLayoutEffect(() => {
    const element = scrollRef.current
    const pending = pendingResize.current
    if (!element || !pending || items !== virtualizer.getVirtualItems()) return
    pendingResize.current = null
    // The browser may have clamped the old top when a short final row shrank.
    // Include any user movement since measurement while restoring that clamp.
    const maxTop = element.scrollHeight - element.clientHeight
    const userDelta = element.scrollTop - Math.min(pending.top, maxTop)
    element.scrollTop = pending.top + pending.delta + userDelta
  }, [items, virtualizer])

  const updateCurrentCard = useCallback(() => {
    const top = (scrollRef.current?.scrollTop ?? 0) + labelHeight
    setActiveKey(currentReviewCard(rows, virtualizer.getVirtualItems(), top)?.key ?? null)
  }, [virtualizer, rows, labelHeight])
  useLayoutEffect(updateCurrentCard, [updateCurrentCard, items])
  useEffect(() => {
    treeRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeKey])
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])

  const scrollToCard = useCallback((entry: TreeEntry) => {
    const index = indexByKey.get(entry.cardKey)
    if (index === undefined) return
    setFlashKey(entry.cardKey)
    virtualizer.scrollToIndex(index, { align: 'start' })
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlashKey(null), 1200)
  }, [indexByKey, virtualizer])

  const activeRow = rows[indexByKey.get(activeKey ?? '') ?? 0]
  const pinned = activeRow?.kind === 'card' && activeRow.source.kind === 'working'
    ? rows[indexByKey.get(`section:${activeRow.source.diffType}`)!]
    : rows[0]

  const enterCommit = useCallback((commit: GitLogEntry) => {
    setViewMode((prev) =>
      prev.kind === 'commit' && prev.commit.hash === commit.hash
        ? { kind: 'overview' }
        : { kind: 'commit', commit },
    )
    setFilter('')
    setFlashKey(null)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [])

  const backToOverview = useCallback(() => {
    setViewMode({ kind: 'overview' })
    setFilter('')
    setFlashKey(null)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [])

  if (!workingDir) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm bg-background h-full">
        {t('未选择工作区')}
      </div>
    )
  }

  const showGitBar = canRunGitOperations && projectId && workspaceId && branchName && targetBranch
  const isLoadingMain = viewMode.kind === 'commit' ? commitFilesLoading : changesLoading

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-background">
      {showGitBar && onConflict && onResolveConflicts && (
        <GitStatusBar
          projectId={projectId!}
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

      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 shrink-0 min-h-[37px]">
        {viewMode.kind === 'overview' ? (
          <>
            <GitGraph size={14} className="text-muted-foreground shrink-0" />
            <span className="text-xs font-semibold text-foreground">{t('代码审查')}</span>
            <span className="text-xs text-muted-foreground">
              {t('{count} 个文件', { count: totals.files })}
            </span>
            <DiffStat additions={totals.additions} deletions={totals.deletions} />
            {branchName && targetBranch && (
              <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground font-mono truncate">
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
            <span aria-hidden="true" className="text-muted-foreground/50 text-xs">/</span>
            <span className="text-[11px] font-mono text-muted-foreground shrink-0">{viewMode.commit.shortHash}</span>
            <span className="text-xs text-foreground truncate">{viewMode.commit.message}</span>
            <DiffStat className="ml-auto" additions={totals.additions} deletions={totals.deletions} />
          </>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="relative flex-1 min-w-0 min-h-0">
          {pinned?.kind === 'section' && !isLoadingMain && !changesError && (
            <div data-review-pinned className="pointer-events-none absolute inset-x-0 top-0 z-10">
              <SectionLabel section={pinned.section} count={pinned.count} />
            </div>
          )}
          <div ref={scrollRef} onScroll={updateCurrentCard} data-review-scroll
            className="h-full overflow-y-auto scrollbar-app-thin [overflow-anchor:none]">
            {isLoadingMain ? (
              <div className="p-3 space-y-3">
                {[0, 1].map((i) => (
                  <div key={i} className="rounded-md border border-border overflow-hidden">
                    <div className="h-8 bg-muted/60 animate-pulse motion-reduce:animate-none" />
                    <div className="p-3 space-y-2">
                      <div className="h-3 w-2/3 bg-muted animate-pulse motion-reduce:animate-none rounded-sm" />
                      <div className="h-3 w-1/2 bg-muted animate-pulse motion-reduce:animate-none rounded-sm" />
                      <div className="h-3 w-3/4 bg-muted animate-pulse motion-reduce:animate-none rounded-sm" />
                    </div>
                  </div>
                ))}
              </div>
            ) : changesError && viewMode.kind === 'overview' ? (
              <div className="flex-1 flex items-center justify-center py-16 text-destructive-ink text-sm">
                {t('变更加载失败')}
              </div>
            ) : allEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <FileCode2 size={28} className="mb-2 text-muted-foreground/70" />
                <span className="text-xs">
                  {filter.trim()
                    ? t('没有匹配筛选条件的文件')
                    : viewMode.kind === 'commit'
                      ? t('该提交没有文件变更')
                      : t('没有待审查的变更')}
                </span>
              </div>
            ) : (
              <div className="relative" style={{
                height: totalSize,
                // Leave just enough trailing space to start-align even a short last card.
                minHeight: `calc(100% + ${Math.max(0, lastStart - labelHeight)}px)`,
              }}>
                {items.map(item => {
                  const row = rows[item.index]
                  return (
                    <div key={item.key} data-index={item.index} ref={virtualizer.measureElement}
                      className="absolute inset-x-0" style={{ top: item.start }}>
                      {row.kind === 'section' ? (
                        <div style={{ height: SECTION_HEIGHT }}>
                          {row.key !== pinned?.key && <SectionLabel section={row.section} count={row.count} />}
                        </div>
                      ) : (
                        <div className="px-3">
                          <DiffCard row={row} workingDir={workingDir} state={cardStates.get(row.key) ?? DEFAULT_CARD_STATE}
                            onStateChange={updateCard} mayLoad={!virtualizer.isScrolling || flashKey === row.key}
                            flash={flashKey === row.key} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <aside
          className="shrink-0 border-l border-border flex flex-col min-h-0"
          style={{ width: 'clamp(15rem, 24%, 22rem)' }}
        >
          <div className="p-2 shrink-0">
            <SearchField size="sm" value={filter} onValueChange={setFilter} placeholder={t('筛选文件...')} />
          </div>

          <div ref={treeRef} className="flex-1 overflow-y-auto scrollbar-app-thin px-1.5 pb-1.5 min-h-0">
            {allEntries.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {filter.trim() ? t('无匹配文件') : t('暂无变更文件')}
              </div>
            ) : (
              <TreeChildren node={tree} depth={0} activeKey={activeKey} onSelect={scrollToCard} />
            )}
          </div>

          <div className="shrink-0 border-t border-border/60 max-h-[40%] flex flex-col min-h-0">
            <div className="flex items-center gap-1.5 px-3 py-2 shrink-0">
              <History size={12} className="text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">
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
