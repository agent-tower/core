import React, { useState, useCallback, useRef } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { History, Loader2, FileCode2, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGitCommitFiles, useGitCommitDiff, type GitChangeEntry } from '@/hooks/use-git'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from '@/hooks/query-keys'
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

/* Thin scrollbar style (inline) */
const SCROLL_STYLE = `
  .history-scroll::-webkit-scrollbar { width: 4px; height: 4px; }
  .history-scroll::-webkit-scrollbar-track { background: transparent; }
  .history-scroll::-webkit-scrollbar-thumb { background: #d4d4d4; border-radius: 2px; }
  .history-scroll::-webkit-scrollbar-thumb:hover { background: #a3a3a3; }
`

/** Diff line renderer */
const DiffLine: React.FC<{ line: string; lineNum: number }> = ({ line, lineNum }) => {
  let bgClass = ''
  let textClass = 'text-neutral-700'
  if (line.startsWith('+') && !line.startsWith('+++')) {
    bgClass = 'bg-emerald-50'; textClass = 'text-emerald-800'
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    bgClass = 'bg-red-50'; textClass = 'text-red-800'
  } else if (line.startsWith('@@')) {
    bgClass = 'bg-blue-50'; textClass = 'text-blue-700'
  } else if (line.startsWith('diff ') || line.startsWith('index ')) {
    textClass = 'text-neutral-400'
  }
  return (
    <div className={cn('flex', bgClass)}>
      <span className="w-10 shrink-0 text-right pr-2 text-neutral-400 select-none border-r border-neutral-100">{lineNum}</span>
      <span className={cn('pl-2 whitespace-pre', textClass)}>{line}</span>
    </div>
  )
}

/** Diff viewer for a file in a commit */
const CommitDiffViewer: React.FC<{ workingDir: string; hash: string; filePath: string }> = ({ workingDir, hash, filePath }) => {
  const { t } = useI18n()
  const { data, isLoading, isError } = useGitCommitDiff(workingDir, hash, filePath)
  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center text-neutral-500">
      <Loader2 size={16} className="animate-spin mr-2" /><span className="text-xs">{t('Loading diff...')}</span>
    </div>
  )
  if (isError) return <div className="flex-1 flex items-center justify-center text-red-500 text-xs">{t('Failed to load diff.')}</div>
  const diff = data?.diff || ''
  if (!diff.trim()) return <div className="flex-1 flex items-center justify-center text-neutral-400 text-xs">{t('No diff content available.')}</div>
  const lines = diff.split('\n')
  return (
    <div className="flex-1 overflow-auto history-scroll font-mono text-xs leading-5">
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
    <div className="pl-7 py-1 text-xs text-neutral-400 flex items-center gap-1">
      <Loader2 size={12} className="animate-spin" /><span>{t('Loading...')}</span>
    </div>
  )
  const files = data?.files || []
  if (files.length === 0) return <div className="pl-7 py-1 text-xs text-neutral-400">{t('No files changed')}</div>
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
              'flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer w-full text-left',
              selectedPath === f.path ? 'bg-blue-50' : 'hover:bg-neutral-50'
            )}
          >
            <span className={cn('w-3.5 h-3.5 flex items-center justify-center text-[9px] font-bold border rounded-sm shrink-0', colorClass)}>
              {f.status}
            </span>
            <span className="text-[11px] text-neutral-900 truncate">{basename(f.path)}</span>
            {dir && <span className="text-[10px] text-neutral-400 truncate ml-auto shrink-0">{dir}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** History Tab main component */
export const HistoryView: React.FC<{ workingDir?: string }> = ({ workingDir }) => {
  const { t } = useI18n()
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
    <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm bg-white h-full">{t('No workspace selected.')}</div>
  )
  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center text-neutral-500 bg-white h-full">
      <Loader2 size={16} className="animate-spin mr-2" /><span className="text-sm">{t('Loading history...')}</span>
    </div>
  )
  if (isError) return (
    <div className="flex-1 flex items-center justify-center text-red-500 text-sm bg-white h-full">{t('Failed to load history.')}</div>
  )
  if (commits.length === 0) return (
    <div className="flex-1 flex flex-col items-center justify-center py-12 text-neutral-400 bg-white h-full">
      <History size={28} className="mb-2" /><span className="text-xs">{t('No commit history')}</span>
    </div>
  )

  const selectedCommit = commits.find(c => c.hash === selectedHash)

  return (
    <div className="flex h-full bg-white" style={isDragging ? { userSelect: 'none', cursor: 'col-resize' } : undefined}>
      <style>{SCROLL_STYLE}</style>

      {/* Left: commit list with inline file expansion */}
      <div className="border-r border-neutral-200 flex flex-col shrink-0" style={{ width: panelWidth }}>
        <div className="px-3 py-2.5 border-b border-neutral-100 shrink-0">
          <div className="flex items-center gap-2">
            <History size={14} className="text-neutral-500" />
            <span className="text-xs font-semibold text-neutral-900">{t('History')}</span>
            <span className="text-[10px] bg-neutral-100 px-1.5 py-0.5 rounded text-neutral-500">{commits.length}</span>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-auto history-scroll p-1.5">
          {commits.map((commit) => {
            const isSelected = selectedHash === commit.hash
            return (
              <div key={commit.hash}>
                <button
                  type="button"
                  onClick={() => handleSelectCommit(commit.hash)}
                  className={cn(
                    'flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer w-full text-left group',
                    isSelected ? 'bg-blue-50' : 'hover:bg-neutral-50'
                  )}
                >
                  <div className="flex flex-col items-center shrink-0 pt-1">
                    <div className={cn(
                      'w-2 h-2 rounded-full shrink-0 transition-colors',
                      isSelected ? 'bg-blue-500' : 'bg-neutral-300 group-hover:bg-neutral-500'
                    )} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-mono text-blue-600 shrink-0">{commit.shortHash}</span>
                      <span className="text-xs text-neutral-900 truncate flex-1">{commit.message}</span>
                      <ChevronRight size={12} className={cn('shrink-0 text-neutral-400 transition-transform', isSelected && 'rotate-90')} />
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10px] text-neutral-500 truncate">{commit.author}</span>
                      <span className="text-[10px] text-neutral-400">{timeAgo(commit.timestamp)}</span>
                    </div>
                  </div>
                </button>
                {isSelected && (
                  <>
                    {commit.body && (
                      <div className="pl-7 pr-2 py-1.5 text-[11px] text-neutral-600 whitespace-pre-wrap leading-4 border-l-2 border-blue-100 ml-3">
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
              className="w-full py-2 text-xs text-neutral-500 hover:text-neutral-700 hover:bg-neutral-50 rounded transition-colors flex items-center justify-center gap-1.5"
            >
              {isFetchingNextPage ? <><Loader2 size={12} className="animate-spin" /> {t('Loading...')}</> : t('Load more')}
            </button>
          )}
        </div>
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        className={cn('w-1 shrink-0 cursor-col-resize transition-colors', isDragging ? 'bg-blue-400' : 'bg-transparent hover:bg-blue-300')}
      />

      {/* Right: diff viewer */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedFile && selectedHash ? (
          <>
            <div className="px-3 py-2 border-b border-neutral-100 flex items-center gap-2 shrink-0">
              <FileCode2 size={14} className="text-neutral-500" />
              <span className="text-xs font-medium text-neutral-700 truncate">{selectedFile}</span>
              <span className="text-[10px] text-neutral-400">({selectedCommit?.shortHash})</span>
            </div>
            <CommitDiffViewer workingDir={workingDir} hash={selectedHash} filePath={selectedFile} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-neutral-400">
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
