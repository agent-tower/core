import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { History, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGitCommitFiles, useGitCommitDiff, type GitChangeEntry, type GitLogResponse } from '@/hooks/use-git'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from '@/hooks/query-keys'

const PAGE_SIZE = 50

const STATUS_COLOR: Record<string, string> = {
  M: 'text-amber-600 border-amber-200 bg-amber-50',
  A: 'text-emerald-600 border-emerald-200 bg-emerald-50',
  D: 'text-red-600 border-red-200 bg-red-50',
  R: 'text-blue-600 border-blue-200 bg-blue-50',
}

function timeAgo(ts: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - ts
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
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

/** Inline diff for a file in a commit (dark theme, same as MobileChangesView) */
function InlineCommitDiff({ workingDir, hash, filePath }: { workingDir: string; hash: string; filePath: string }) {
  const { data, isLoading, isError } = useGitCommitDiff(workingDir, hash, filePath)

  if (isLoading) return (
    <div className="flex items-center gap-2 px-3 py-4 text-neutral-400">
      <Loader2 size={14} className="animate-spin" /><span className="text-xs">Loading diff...</span>
    </div>
  )
  if (isError) return <div className="px-3 py-3 text-xs text-red-500">Failed to load diff.</div>

  const diff = data?.diff || ''
  if (!diff.trim()) return <div className="px-3 py-3 text-xs text-neutral-400">No diff content.</div>

  const lines = diff.split('\n')
  return (
    <div className="overflow-x-auto bg-neutral-950 rounded-lg mx-3 mb-3 font-mono text-[11px] leading-5">
      {lines.map((line, i) => {
        let bgClass = ''
        let textClass = 'text-neutral-400'
        if (line.startsWith('+') && !line.startsWith('+++')) {
          bgClass = 'bg-emerald-950/40'; textClass = 'text-emerald-400'
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          bgClass = 'bg-red-950/40'; textClass = 'text-red-400'
        } else if (line.startsWith('@@')) {
          bgClass = 'bg-blue-950/30'; textClass = 'text-blue-400'
        }
        return <div key={i} className={cn('px-3 whitespace-pre', bgClass, textClass)}>{line}</div>
      })}
    </div>
  )
}

/** Expandable file item within a commit */
function ExpandableFileItem({ entry, workingDir, hash }: { entry: GitChangeEntry; workingDir: string; hash: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const colorClass = STATUS_COLOR[entry.status] || STATUS_COLOR.M
  const dir = dirname(entry.path)

  return (
    <div>
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className={cn('flex items-center gap-2.5 w-full px-4 py-2.5 text-left active:bg-neutral-50', isOpen && 'bg-neutral-50')}
      >
        <span className={cn('w-5 h-5 flex items-center justify-center text-[10px] font-bold border rounded shrink-0', colorClass)}>
          {entry.status}
        </span>
        <div className="flex-1 min-w-0">
          <span className="text-sm text-neutral-900 truncate block">{basename(entry.path)}</span>
          {dir && <span className="text-[11px] text-neutral-400 truncate block">{dir}</span>}
        </div>
        <span className="text-neutral-400 shrink-0">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {isOpen && <InlineCommitDiff workingDir={workingDir} hash={hash} filePath={entry.path} />}
    </div>
  )
}

/** Expandable commit item: shows commit info, expands to file list */
function CommitItem({ commit, workingDir }: { commit: { hash: string; shortHash: string; author: string; timestamp: number; message: string; body: string }; workingDir: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const { data, isLoading } = useGitCommitFiles(workingDir, isOpen ? commit.hash : null)
  const files = data?.files || []

  return (
    <div>
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className={cn('flex items-start gap-3 w-full px-4 py-3 text-left active:bg-neutral-50', isOpen && 'bg-neutral-50')}
      >
        <div className="flex flex-col items-center shrink-0 pt-0.5">
          <div className={cn('w-2.5 h-2.5 rounded-full shrink-0', isOpen ? 'bg-blue-500' : 'bg-neutral-300')} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-blue-600 shrink-0">{commit.shortHash}</span>
            <span className="text-sm text-neutral-900 truncate flex-1">{commit.message}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[11px] text-neutral-500 truncate">{commit.author}</span>
            <span className="text-[11px] text-neutral-400">{timeAgo(commit.timestamp)}</span>
          </div>
        </div>
        <span className="text-neutral-400 shrink-0 pt-0.5">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {isOpen && (
        <div className="pl-4 border-l-2 border-blue-100 ml-[22px]">
          {commit.body && (
            <div className="px-3 py-2 text-xs text-neutral-600 whitespace-pre-wrap leading-4">
              {commit.body}
            </div>
          )}
          {isLoading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-neutral-400">
              <Loader2 size={14} className="animate-spin" /><span className="text-xs">Loading files...</span>
            </div>
          ) : files.length === 0 ? (
            <div className="px-3 py-3 text-xs text-neutral-400">No files changed</div>
          ) : (
            <div className="divide-y divide-neutral-100">
              {files.map((f: GitChangeEntry) => (
                <ExpandableFileItem key={f.path} entry={f} workingDir={workingDir} hash={commit.hash} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Main component */
export function MobileHistoryView({ workingDir }: { workingDir?: string }) {
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

  if (!workingDir) return (
    <div className="flex-1 flex items-center justify-center text-neutral-400 text-sm">No workspace selected.</div>
  )
  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center text-neutral-400">
      <Loader2 size={16} className="animate-spin mr-2" /><span className="text-sm">Loading history...</span>
    </div>
  )
  if (isError) return (
    <div className="flex-1 flex items-center justify-center text-red-500 text-sm">Failed to load history.</div>
  )
  if (commits.length === 0) return (
    <div className="flex-1 flex flex-col items-center justify-center text-neutral-400 py-16">
      <History size={28} className="mb-3" /><span className="text-sm">No commit history</span>
    </div>
  )

  return (
    <div className="flex-1 overflow-y-auto overscroll-y-contain">
      <div className="divide-y divide-neutral-100">
        {commits.map(commit => (
          <CommitItem key={commit.hash} commit={commit} workingDir={workingDir} />
        ))}
      </div>

      {hasNextPage && (
        <button
          type="button"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="w-full py-4 text-sm text-neutral-500 active:text-neutral-700 active:bg-neutral-50 flex items-center justify-center gap-2"
        >
          {isFetchingNextPage ? <><Loader2 size={14} className="animate-spin" /> Loading...</> : 'Load more'}
        </button>
      )}
    </div>
  )
}
