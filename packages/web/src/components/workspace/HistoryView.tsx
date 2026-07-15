import React, { useState, useCallback, useRef } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { History, Loader2, FileCode2, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGitCommitFiles, useGitCommitDiff, type GitChangeEntry } from '@/hooks/use-git'
import { apiClient } from '@/lib/api-client'
import { getGitHistoryRefreshInterval } from '@/lib/git-refresh-policy'
import { queryKeys } from '@/hooks/query-keys'
import { useGitVisibilityStore } from '@/stores/git-visibility-store'
import type { GitLogResponse } from '@/hooks/use-git'
import { translate, useI18n } from '@/lib/i18n'

const PAGE_SIZE = 50

const STATUS_COLOR_MAP: Record<string, string> = {
  M: 'text-amber-600 border-amber-200 bg-amber-50',
  A: 'text-emerald-600 border-emerald-200 bg-emerald-50',
  D: 'text-red-600 border-red-200 bg-red-50',
  R: 'text-blue-600 border-blue-200 bg-blue-50',
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

function basename(p: string) {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function dirname(p: string) {
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : ''
}

/** Diff line renderer */
const DiffLine: React.FC<{ line: string; lineNum: number }> = ({ line, lineNum }) => {
  let bgClass = ''
  let textClass = 'text-foreground/90'
  if (line.startsWith('+') && !line.startsWith('+++')) {
    bgClass = 'bg-success/10'
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    bgClass = 'bg-destructive/10'
  } else if (line.startsWith('@@')) {
    bgClass = 'bg-info/5'; textClass = 'text-info'
  } else if (line.startsWith('diff ') || line.startsWith('index ')) {
    textClass = 'text-muted-foreground/70'
  }
  return (
    <div className={cn('flex', bgClass)}>
      <span className="w-10 shrink-0 text-right pr-2 text-muted-foreground/60 select-none border-r border-border/60">{lineNum}</span>
      <span className={cn('pl-2 whitespace-pre', textClass)}>{line}</span>
    </div>
  )
}

/** Diff viewer for a file in a commit */
const CommitDiffViewer: React.FC<{ workingDir: string; hash: string; filePath: string }> = ({ workingDir, hash, filePath }) => {
  const { t } = useI18n()
  const { data, isLoading, isError } = useGitCommitDiff(workingDir, hash, filePath)
  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground">
      <Loader2 size={16} className="animate-spin mr-2" /><span className="text-xs">{t('Loading diff...')}</span>
    </div>
  )
  if (isError) return <div className="flex-1 flex items-center justify-center text-destructive text-xs">{t('Failed to load diff.')}</div>
  const diff = data?.diff || ''
  if (!diff.trim()) return <div className="flex-1 flex items-center justify-center text-muted-foreground/70 text-xs">{t('No diff content available.')}</div>
  const lines = diff.split('\n')
  return (
    <div className="flex-1 overflow-auto scrollbar-app-thin font-mono text-xs leading-5">
      {lines.map((line, i) => <DiffLine key={i} line={line} lineNum={i + 1} />)}
    </div>
  )
}

/** Inline file list under a commit (clickable to select file for diff) */
const CommitFileList: React.FC<{
  workingDir: string; hash: string; selectedPath: string | null; onSelectFile: (path: string) => void
}> = ({ workingDir, hash, selectedPath, onSelectFile }) => {
  const { t } = useI18n()
  const { data, isLoading } = useGitCommitFiles(workingDir, hash)
  if (isLoading) return (
    <div className="pl-7 py-1 text-xs text-muted-foreground/70 flex items-center gap-1">
      <Loader2 size={12} className="animate-spin" /><span>{t('Loading...')}</span>
    </div>
  )
  const files = data?.files || []
  if (files.length === 0) return <div className="pl-7 py-1 text-xs text-muted-foreground/70">{t('No files changed')}</div>
  return (
    <div className="pl-7 pb-1 space-y-0.5">
      {files.map((f: GitChangeEntry) => {
        const colorClass = STATUS_COLOR_MAP[f.status] || STATUS_COLOR_MAP.M
        const dir = dirname(f.path)
        return (
          <button
            key={f.path}
            type="button"
            onClick={(e) => { e.stopPropagation(); onSelectFile(f.path) }}
            className={cn(
              'flex items-center gap-2 px-1.5 py-1 rounded-sm cursor-pointer w-full text-left',
              selectedPath === f.path ? 'bg-muted' : 'hover:bg-muted/60'
            )}
          >
            <span className={cn('w-4 h-4 flex items-center justify-center text-[11px] font-semibold border rounded-sm shrink-0', colorClass)}>
              {f.status}
            </span>
            <span className="text-xs text-foreground truncate">{basename(f.path)}</span>
            {dir && <span className="text-[11px] text-muted-foreground/70 truncate ml-auto shrink-0">{dir}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** History Tab main component */
export const HistoryView: React.FC<{ workingDir?: string }> = ({ workingDir }) => {
  const { t } = useI18n()
  const visibleContext = useGitVisibilityStore((state) => state.visibleContext)
  const refreshInterval = getGitHistoryRefreshInterval(workingDir, visibleContext)
  const {
    data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: queryKeys.git.log(workingDir || ''),
    queryFn: ({ pageParam = 0 }) =>
      apiClient.get<GitLogResponse>('/git/log', {
        params: { workingDir: workingDir || '', limit: String(PAGE_SIZE), skip: String(pageParam) },
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.commits.length < PAGE_SIZE ? undefined : allPages.length * PAGE_SIZE,
    enabled: !!workingDir,
    refetchInterval: refreshInterval,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: refreshInterval ? 'always' : false,
    refetchOnReconnect: refreshInterval ? 'always' : false,
  })

  const commits = data?.pages.flatMap(p => p.commits) || []

  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  // Resizable left panel
  const [panelWidth, setPanelWidth] = useState(280)
  const [isDragging, setIsDragging] = useState(false)
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    const startX = e.clientX
    const startWidth = panelWidth
    const onMouseMove = (ev: MouseEvent) => {
      const next = Math.min(480, Math.max(180, startWidth + (ev.clientX - startX)))
      setPanelWidth(next)
    }
    const onMouseUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [panelWidth])

  const handleSelectCommit = (hash: string) => {
    if (selectedHash === hash) { setSelectedHash(null); setSelectedFile(null) }
    else { setSelectedHash(hash); setSelectedFile(null) }
  }

  // Scroll container ref for load-more detection
  const scrollRef = useRef<HTMLDivElement>(null)

  if (!workingDir) return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm bg-background h-full">{t('No workspace selected.')}</div>
  )
  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground bg-background h-full">
      <Loader2 size={16} className="animate-spin mr-2" /><span className="text-sm">{t('Loading history...')}</span>
    </div>
  )
  if (isError) return (
    <div className="flex-1 flex items-center justify-center text-destructive text-sm bg-background h-full">{t('Failed to load history.')}</div>
  )
  if (commits.length === 0) return (
    <div className="flex-1 flex flex-col items-center justify-center py-12 text-muted-foreground/60 bg-background h-full">
      <History size={28} className="mb-2" /><span className="text-xs">{t('No commit history')}</span>
    </div>
  )

  const selectedCommit = commits.find(c => c.hash === selectedHash)

  return (
    <div className="flex h-full bg-background" style={isDragging ? { userSelect: 'none', cursor: 'col-resize' } : undefined}>
      {/* Left: commit list with inline file expansion */}
      <div className="border-r border-border flex flex-col shrink-0" style={{ width: panelWidth }}>
        <div className="px-3 py-2.5 border-b border-border/60 shrink-0">
          <div className="flex items-center gap-2">
            <History size={14} className="text-muted-foreground" />
            <span className="text-xs font-semibold text-foreground">{t('History')}</span>
            <span className="text-[11px] bg-muted px-1.5 py-0.5 rounded-full text-muted-foreground">{commits.length}</span>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-auto scrollbar-app-thin p-1.5">
          {commits.map((commit) => {
            const isSelected = selectedHash === commit.hash
            return (
              <div key={commit.hash}>
                <button
                  type="button"
                  onClick={() => handleSelectCommit(commit.hash)}
                  className={cn(
                    'flex items-start gap-2 px-2 py-1.5 rounded-sm cursor-pointer w-full text-left group',
                    isSelected ? 'bg-muted' : 'hover:bg-muted/60'
                  )}
                >
                  <div className="flex flex-col items-center shrink-0 pt-1">
                    <div className={cn(
                      'w-2 h-2 rounded-full shrink-0 transition-colors',
                      isSelected ? 'bg-brand' : 'bg-border group-hover:bg-muted-foreground/60'
                    )} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-mono text-muted-foreground shrink-0">{commit.shortHash}</span>
                      <span className="text-xs text-foreground truncate flex-1">{commit.message}</span>
                      <ChevronRight size={12} className={cn('shrink-0 text-muted-foreground/70 transition-transform', isSelected && 'rotate-90')} />
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[11px] text-muted-foreground truncate">{commit.author}</span>
                      <span className="text-[11px] text-muted-foreground/70">{timeAgo(commit.timestamp)}</span>
                    </div>
                  </div>
                </button>
                {isSelected && (
                  <>
                    {commit.body && (
                      <div className="pl-7 pr-2 py-1.5 text-[11px] text-muted-foreground whitespace-pre-wrap leading-5 border-l-2 border-border ml-3">
                        {commit.body}
                      </div>
                    )}
                    <CommitFileList
                      workingDir={workingDir}
                      hash={commit.hash}
                      selectedPath={selectedFile}
                      onSelectFile={setSelectedFile}
                    />
                  </>
                )}
              </div>
            )
          })}

          {/* Load more */}
          {hasNextPage && (
            <button
              type="button"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="w-full py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-sm transition-colors flex items-center justify-center gap-1.5"
            >
              {isFetchingNextPage ? <><Loader2 size={12} className="animate-spin" /> {t('Loading...')}</> : t('Load more')}
            </button>
          )}
        </div>
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        className={cn('w-1 shrink-0 cursor-col-resize transition-colors', isDragging ? 'bg-info/60' : 'bg-transparent hover:bg-info/30')}
      />

      {/* Right: diff viewer */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedFile && selectedHash ? (
          <>
            <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2 shrink-0">
              <FileCode2 size={14} className="text-muted-foreground" />
              <span className="text-xs font-medium text-foreground truncate">{selectedFile}</span>
              <span className="text-[11px] text-muted-foreground/70">({selectedCommit?.shortHash})</span>
            </div>
            <CommitDiffViewer workingDir={workingDir} hash={selectedHash} filePath={selectedFile} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground/60">
            <div className="flex flex-col items-center gap-2">
              <FileCode2 size={28} />
              <span className="text-xs">{selectedHash ? t('Select a file to view diff') : t('Select a commit to view changes')}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
