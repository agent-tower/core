import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronRight, GitGraph, Loader2, RefreshCw, Upload } from 'lucide-react'
import type { GitOperationStatus } from '@agent-tower/shared'
import { useAbortOperation, useMergeWorkspace, useRebaseWorkspace } from '@/hooks/use-workspaces'
import type { GitChangesResponse } from '@/hooks/use-git'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { SubmitChangesDialog } from './SubmitChangesDialog'
import { getConflictDetails, type ConflictDetails } from './GitOperationsDialog'

interface WorkspaceChangeSummaryBarProps {
  workspaceId: string
  branchName: string
  targetBranch: string
  commitMessage?: string | null
  changes?: GitChangesResponse
  gitStatus?: GitOperationStatus
  isGitStatusLoading?: boolean
  canRunGitOperations: boolean
  onOpenChanges: () => void
  onRefreshCommitMessage?: () => void | Promise<unknown>
  onConflict: (details?: ConflictDetails) => void
  className?: string
}

function getChangeTotals(changes?: GitChangesResponse) {
  const entries = [...(changes?.uncommitted ?? []), ...(changes?.committed ?? [])]
  return entries.reduce(
    (totals, entry) => ({
      files: totals.files + 1,
      additions: totals.additions + (entry.additions ?? 0),
      deletions: totals.deletions + (entry.deletions ?? 0),
    }),
    { files: 0, additions: 0, deletions: 0 },
  )
}

function handleMutationError(
  err: unknown,
  fallbackMessage: string,
  onConflict: (details: ConflictDetails) => void,
  setError: (message: string) => void,
) {
  const details = getConflictDetails(err)
  if (details) {
    onConflict(details)
    return
  }
  setError(err instanceof Error ? err.message : fallbackMessage)
}

export function WorkspaceChangeSummaryBar({
  workspaceId,
  branchName,
  targetBranch,
  commitMessage,
  changes,
  gitStatus,
  isGitStatusLoading,
  canRunGitOperations,
  onOpenChanges,
  onRefreshCommitMessage,
  onConflict,
  className,
}: WorkspaceChangeSummaryBarProps) {
  const { t } = useI18n()
  const rebaseWorkspace = useRebaseWorkspace()
  const mergeWorkspace = useMergeWorkspace()
  const abortOperation = useAbortOperation()
  const [isSubmitDialogOpen, setIsSubmitDialogOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const totals = useMemo(() => getChangeTotals(changes), [changes])
  const changedLines = totals.additions + totals.deletions
  const hasChanges = totals.files > 0 && changedLines > 0
  const hasConflicts = (gitStatus?.conflictedFiles.length ?? 0) > 0
  const isOperationInProgress = Boolean(gitStatus && gitStatus.operation !== 'idle')
  const isDirty = Boolean(gitStatus && (gitStatus.hasUncommittedChanges || gitStatus.untrackedCount > 0))
  const dirtyCount = (gitStatus?.uncommittedCount ?? 0) + (gitStatus?.untrackedCount ?? 0)
  const hasSourceUpdates = (gitStatus?.behind ?? 0) > 0
  const hasMergeableCommits = (gitStatus?.ahead ?? 0) > 0
  const isActionLoading = isGitStatusLoading || (!gitStatus && canRunGitOperations)
  const canUpdate = Boolean(
    canRunGitOperations
    && workspaceId
    && gitStatus
    && hasSourceUpdates
    && !hasConflicts
    && !isOperationInProgress
    && !isDirty,
  )
  const canMerge = Boolean(
    canRunGitOperations
    && workspaceId
    && gitStatus
    && hasMergeableCommits
    && !hasSourceUpdates
    && !hasConflicts
    && !isOperationInProgress
    && !isDirty,
  )

  useEffect(() => {
    if (isSubmitDialogOpen) {
      void onRefreshCommitMessage?.()
    }
  }, [isSubmitDialogOpen, onRefreshCommitMessage])

  if (!hasChanges) {
    return null
  }

  const statusLabel = (() => {
    if (hasConflicts) return t('冲突')
    if (gitStatus?.operation === 'rebase') return t('变基中')
    if (gitStatus?.operation === 'merge') return t('合并中')
    if (dirtyCount > 0) return t('{count} 未提交', { count: dirtyCount })
    if (hasSourceUpdates) return t('落后 {count}', { count: gitStatus?.behind ?? 0 })
    if (hasMergeableCommits) return t('可合并')
    return t('已是最新')
  })()

  const summaryText = t('{files} 个文件 · {lines} 行', { files: totals.files, lines: changedLines })

  const handleUpdate = () => {
    if (!canUpdate) return
    setError(null)
    rebaseWorkspace.mutate(workspaceId, {
      onError: (err: unknown) => {
        handleMutationError(err, t('更新失败，请稍后重试'), (details) => onConflict(details), setError)
      },
    })
  }

  const handleOpenSubmitDialog = () => {
    if (!canMerge) return
    setError(null)
    setIsSubmitDialogOpen(true)
  }

  const handleSubmitConfirm = (finalMessage: string | undefined) => {
    setError(null)
    mergeWorkspace.mutate({ id: workspaceId, commitMessage: finalMessage }, {
      onSuccess: () => setIsSubmitDialogOpen(false),
      onError: (err: unknown) => {
        handleMutationError(err, t('提交失败，请稍后重试'), (details) => {
          setIsSubmitDialogOpen(false)
          onConflict(details)
        }, setError)
      },
    })
  }

  const handleCloseSubmitDialog = () => {
    if (mergeWorkspace.isPending) return
    setIsSubmitDialogOpen(false)
    setError(null)
  }

  return (
    <>
      <div className={cn('space-y-1', className)}>
        <div className="flex items-center gap-1.5 rounded-lg bg-muted/25 px-2 py-1.5">
          <button
            type="button"
            onClick={onOpenChanges}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-muted/55 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            aria-label={t('查看变更详情')}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-background/70 text-muted-foreground">
              <GitGraph size={13} />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-xs font-medium text-foreground">{summaryText}</span>
              <span className="hidden shrink-0 items-center gap-1 font-mono text-[11px] sm:inline-flex">
                {totals.additions > 0 && <span className="text-success">+{totals.additions}</span>}
                {totals.deletions > 0 && <span className="text-destructive">-{totals.deletions}</span>}
              </span>
              {hasConflicts && <AlertTriangle size={13} className="shrink-0 text-amber-600" />}
              <span className="hidden min-w-0 items-center gap-1 text-[11px] text-muted-foreground md:flex">
                <span className="truncate font-mono">{branchName}</span>
                <span className="text-muted-foreground/40">→</span>
                <span className="truncate font-mono">{targetBranch}</span>
              </span>
              <span className="shrink-0 rounded-full bg-background/75 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {statusLabel}
              </span>
            </span>
            <ChevronRight size={15} className="shrink-0 text-muted-foreground/60" />
          </button>

          <div className="flex shrink-0 items-center gap-1">
            {isOperationInProgress && (
              <button
                type="button"
                onClick={() => abortOperation.mutate(workspaceId)}
                disabled={abortOperation.isPending}
                className="hidden h-7 items-center rounded-md border border-border/70 bg-background px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 sm:inline-flex"
              >
                {abortOperation.isPending ? t('正在撤销...') : t('撤销操作')}
              </button>
            )}
            <button
              type="button"
              onClick={handleUpdate}
              disabled={!canUpdate || rebaseWorkspace.isPending || isActionLoading}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45"
              title={hasSourceUpdates ? t('同步更新') : t('已是最新')}
            >
              {rebaseWorkspace.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              <span>{rebaseWorkspace.isPending ? t('正在同步...') : t('更新')}</span>
            </button>
            <button
              type="button"
              onClick={handleOpenSubmitDialog}
              disabled={!canMerge || mergeWorkspace.isPending || isActionLoading}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
              title={canMerge ? t('合并到 {target}', { target: targetBranch }) : t('提交变更')}
            >
              {mergeWorkspace.isPending ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              <span>{mergeWorkspace.isPending ? t('正在提交...') : t('合并')}</span>
            </button>
          </div>
        </div>
        {error && (
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
            {error}
          </div>
        )}
      </div>

      <SubmitChangesDialog
        isOpen={isSubmitDialogOpen}
        onClose={handleCloseSubmitDialog}
        branchName={branchName}
        targetBranch={targetBranch}
        commitMessage={commitMessage}
        isPending={mergeWorkspace.isPending}
        error={error}
        onConfirm={handleSubmitConfirm}
      />
    </>
  )
}
