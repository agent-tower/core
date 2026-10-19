import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronRight, GitGraph, RefreshCw, Upload } from 'lucide-react'
import type { GitOperationStatus } from '@agent-tower/shared'
import { Badge, Button, DiffStat, Notice } from '@/design-system'
import { useAbortOperation, useMergeWorkspace, useRebaseWorkspace } from '@/hooks/use-workspaces'
import type { GitChangesResponse } from '@/hooks/use-git'
import { useWorkspaceBackgroundServices } from '@/hooks/use-workspace-services'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  isMergeBlockingWorkspaceService,
  isWorkspaceServiceMergeError,
} from '@/lib/workspace-merge'
import { SubmitChangesDialog } from './SubmitChangesDialog'
import { getConflictDetails, type ConflictDetails } from './GitOperationsDialog'

interface WorkspaceChangeSummaryBarProps {
  projectId: string
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
  projectId,
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
  const servicesQuery = useWorkspaceBackgroundServices(workspaceId, isSubmitDialogOpen)
  const activeServices = (servicesQuery.data ?? []).filter(isMergeBlockingWorkspaceService)

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
  const canOpenMerge = Boolean(canRunGitOperations && workspaceId && gitStatus && !hasConflicts && !isOperationInProgress && !isDirty)

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
    if (!canOpenMerge) return
    setError(null)
    setIsSubmitDialogOpen(true)
  }

  const handleSubmitConfirm = (finalMessage: string | undefined, stopActiveServices: boolean) => {
    setError(null)
    mergeWorkspace.mutate({ id: workspaceId, commitMessage: finalMessage, stopActiveServices }, {
      onSuccess: () => setIsSubmitDialogOpen(false),
      onError: (err: unknown) => {
        if (isWorkspaceServiceMergeError(err)) {
          setError(t('后台服务仍在运行，请确认停止服务后再提交。'))
          return
        }
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
              <DiffStat additions={totals.additions} deletions={totals.deletions} className="hidden sm:inline-flex" />
              {hasConflicts && <AlertTriangle size={13} className="shrink-0 text-warning" />}
              {/* 分支名只占剩余空间（最多到自身宽度）：空间不够时先截它，保住「几个文件 · 几行」 */}
              <span className="hidden min-w-0 basis-0 grow max-w-fit items-center gap-1 text-[11px] text-muted-foreground md:flex">
                <span className="truncate font-mono">{branchName}</span>
                <span aria-hidden="true" className="text-muted-foreground/70">→</span>
                <span className="truncate font-mono">{targetBranch}</span>
              </span>
              <Badge className="bg-background/75">{statusLabel}</Badge>
            </span>
            <ChevronRight size={15} className="shrink-0 text-muted-foreground/70" />
          </button>

          <div className="flex shrink-0 items-center gap-1">
            {isOperationInProgress && (
              <Button
                variant="secondary"
                size="sm"
                className="hidden sm:inline-flex"
                onClick={() => abortOperation.mutate(workspaceId)}
                loading={abortOperation.isPending}
              >
                {abortOperation.isPending ? t('正在撤销...') : t('撤销操作')}
              </Button>
            )}
            <span
              title={hasSourceUpdates ? t('同步更新') : t('已是最新')}
              className={cn('inline-flex', (!canUpdate || isActionLoading) && 'cursor-not-allowed')}
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={handleUpdate}
                disabled={!canUpdate || isActionLoading}
                loading={rebaseWorkspace.isPending}
              >
                {!rebaseWorkspace.isPending && <RefreshCw />}
                {rebaseWorkspace.isPending ? t('正在同步...') : t('更新')}
              </Button>
            </span>
            <span
              title={canMerge ? t('合并到 {target}', { target: targetBranch }) : t('提交变更')}
              className={cn('inline-flex', (!canOpenMerge || isActionLoading) && 'cursor-not-allowed')}
            >
              <Button
                variant="primary"
                size="sm"
                onClick={handleOpenSubmitDialog}
                disabled={!canOpenMerge || isActionLoading}
                loading={mergeWorkspace.isPending}
              >
                {!mergeWorkspace.isPending && <Upload />}
                {mergeWorkspace.isPending ? t('正在提交...') : t('合并')}
              </Button>
            </span>
          </div>
        </div>
        {error && <Notice tone="danger" size="sm">{error}</Notice>}
      </div>

      <SubmitChangesDialog
        projectId={projectId}
        workspaceId={workspaceId}
        canMerge={canMerge}
        isOpen={isSubmitDialogOpen}
        onClose={handleCloseSubmitDialog}
        onBaseBranchSaved={onOpenChanges}
        branchName={branchName}
        targetBranch={targetBranch}
        commitMessage={commitMessage}
        isPending={mergeWorkspace.isPending}
        activeServices={activeServices}
        isCheckingServices={servicesQuery.isLoading}
        serviceCheckFailed={servicesQuery.isError}
        error={error}
        onConfirm={handleSubmitConfirm}
      />
    </>
  )
}
