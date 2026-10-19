import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { History, ChevronDown, ChevronRight } from 'lucide-react'
import { FileStatusBadge, Spinner } from '@/design-system'
import { DiffLine } from '@/components/workspace/DiffLine'
import { cn } from '@/lib/utils'
import { useGitCommitFiles, useGitCommitDiff, type GitChangeEntry, type GitLogResponse } from '@/hooks/use-git'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from '@/hooks/query-keys'
import { translate, useI18n } from '@/lib/i18n'

const PAGE_SIZE = 50

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

/** Inline diff for a file in a commit (dark theme, same as MobileChangesView) */
function InlineCommitDiff({ workingDir, hash, filePath }: { workingDir: string; hash: string; filePath: string }) {
  const { t } = useI18n()
  const { data, isLoading, isError } = useGitCommitDiff(workingDir, hash, filePath)

  if (isLoading) return (
    <div className="flex items-center gap-2 px-3 py-4 text-muted-foreground">
      <Spinner /><span className="text-xs">{t('Loading diff...')}</span>
    </div>
  )
  if (isError) return <div className="px-3 py-3 text-xs text-destructive-ink">{t('Failed to load diff.')}</div>

  const diff = data?.diff || ''
  if (!diff.trim()) return <div className="px-3 py-3 text-xs text-muted-foreground">{t('No diff content available.')}</div>

  const lines = diff.split('\n')
  return (
    <div className="overflow-x-auto scrollbar-app-thin mx-3 mb-3 rounded-lg border border-border/60 bg-background py-1 font-mono text-xs leading-5">
      <div className="min-w-max">
        {lines.map((line, i) => <DiffLine key={i} line={line} lineNum={i + 1} />)}
      </div>
    </div>
  )
}

/** Expandable file item within a commit */
function ExpandableFileItem({ entry, workingDir, hash }: { entry: GitChangeEntry; workingDir: string; hash: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const dir = dirname(entry.path)

  return (
    <div>
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className={cn('flex items-center gap-2.5 w-full px-4 py-2.5 text-left active:bg-accent', isOpen && 'bg-muted/50')}
      >
        <FileStatusBadge status={entry.status} size="md" />
        <div className="flex-1 min-w-0">
          <span className="text-sm text-foreground truncate block">{basename(entry.path)}</span>
          {dir && <span className="text-[11px] text-muted-foreground truncate block">{dir}</span>}
        </div>
        <span className="text-muted-foreground shrink-0">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {isOpen && <InlineCommitDiff workingDir={workingDir} hash={hash} filePath={entry.path} />}
    </div>
  )
}

/** Expandable commit item: shows commit info, expands to file list */
function CommitItem({ commit, workingDir }: { commit: { hash: string; shortHash: string; author: string; timestamp: number; message: string; body: string }; workingDir: string }) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(false)
  const { data, isLoading } = useGitCommitFiles(workingDir, isOpen ? commit.hash : null)
  const files = data?.files || []

  return (
    <div>
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className={cn('flex items-start gap-3 w-full px-4 py-3 text-left active:bg-accent', isOpen && 'bg-muted/50')}
      >
        <div className="flex flex-col items-center shrink-0 pt-0.5">
          <div className={cn('w-2.5 h-2.5 rounded-full shrink-0', isOpen ? 'bg-info' : 'bg-foreground/15')} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground shrink-0">{commit.shortHash}</span>
            <span className="text-sm text-foreground truncate flex-1">{commit.message}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-muted-foreground truncate">{commit.author}</span>
            <span className="text-[11px] text-muted-foreground">{timeAgo(commit.timestamp)}</span>
          </div>
        </div>
        <span className="text-muted-foreground shrink-0 pt-0.5">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {isOpen && (
        <div className="pl-4 border-l-2 border-border ml-[22px]">
          {commit.body && (
            <div className="px-3 py-2 text-xs text-foreground/70 whitespace-pre-wrap leading-4">
              {commit.body}
            </div>
          )}
          {isLoading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-muted-foreground">
              <Spinner /><span className="text-xs">{t('Loading files...')}</span>
            </div>
          ) : files.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">{t('No files changed')}</div>
          ) : (
            <div className="divide-y divide-border/60">
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

  if (!workingDir) return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">{t('No workspace selected.')}</div>
  )
  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground">
      <Spinner size="md" className="mr-2" /><span className="text-sm">{t('Loading history...')}</span>
    </div>
  )
  if (isError) return (
    <div className="flex-1 flex items-center justify-center text-destructive-ink text-sm">{t('Failed to load history.')}</div>
  )
  if (commits.length === 0) return (
    <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground py-16">
      <History size={28} className="mb-3" /><span className="text-sm">{t('No commit history')}</span>
    </div>
  )

  return (
    <div className="flex-1 overflow-y-auto scrollbar-app-thin overscroll-y-contain">
      <div className="divide-y divide-border/60">
        {commits.map(commit => (
          <CommitItem key={commit.hash} commit={commit} workingDir={workingDir} />
        ))}
      </div>

      {hasNextPage && (
        <button
          type="button"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="w-full py-4 text-sm text-muted-foreground active:text-foreground/80 active:bg-accent flex items-center justify-center gap-2"
        >
          {isFetchingNextPage ? <><Spinner /> {t('Loading...')}</> : t('Load more')}
        </button>
      )}
    </div>
  )
}
