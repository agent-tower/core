import { useState, useEffect } from 'react'
import {
  AlertTriangle,
  RefreshCw, Upload, XCircle, FileWarning, Info,
} from 'lucide-react'
import { Button, Notice, Spinner } from '@/design-system'
import { useRebaseWorkspace, useMergeWorkspace, useAbortOperation, useGitStatus } from '@/hooks/use-workspaces'
import { useWorkspaceBackgroundServices } from '@/hooks/use-workspace-services'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  isMergeBlockingWorkspaceService,
  isWorkspaceServiceMergeError,
} from '@/lib/workspace-merge'
import { SubmitChangesDialog } from './SubmitChangesDialog'
import { getConflictDetails, type ConflictDetails } from './GitOperationsDialog'

export interface GitStatusBarProps {
  projectId: string
  workspaceId: string
  branchName: string
  targetBranch: string
  commitMessage?: string | null
  committedFileCount?: number
  onRefreshCommitMessage?: () => void | Promise<unknown>
  onConflict: (details?: ConflictDetails) => void
  onResolveConflicts: () => void
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

export function GitStatusBar({
  projectId,
  workspaceId,
  branchName,
  targetBranch,
  commitMessage,
  committedFileCount,
  onRefreshCommitMessage,
  onConflict,
  onResolveConflicts,
}: GitStatusBarProps) {
  const { t } = useI18n()
  const { data: gitStatus, isLoading } = useGitStatus(workspaceId)
  const rebaseWorkspace = useRebaseWorkspace()
  const mergeWorkspace = useMergeWorkspace()
  const abortOperation = useAbortOperation()

  const [isSubmitDialogOpen, setIsSubmitDialogOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const servicesQuery = useWorkspaceBackgroundServices(workspaceId, isSubmitDialogOpen)
  const activeServices = (servicesQuery.data ?? []).filter(isMergeBlockingWorkspaceService)

  useEffect(() => {
    if (isSubmitDialogOpen) {
      void onRefreshCommitMessage?.()
    }
  }, [isSubmitDialogOpen, onRefreshCommitMessage])

  if (isLoading || !gitStatus) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground border-b border-border/60">
        <Spinner />
        <span className="text-xs">{t('正在检查工作区状态...')}</span>
      </div>
    )
  }

  const hasConflicts = gitStatus.conflictedFiles.length > 0
  const isOperationInProgress = gitStatus.operation !== 'idle'
  const isDirty = gitStatus.hasUncommittedChanges || gitStatus.untrackedCount > 0
  const dirtyCount = gitStatus.uncommittedCount + gitStatus.untrackedCount
  const canUpdate = !hasConflicts && !isOperationInProgress && !isDirty
  const canSubmit = !isDirty
  const noChanges = gitStatus.operation === 'idle' && gitStatus.ahead === 0 && gitStatus.behind === 0 && !isDirty && !hasConflicts

  const handleUpdate = () => {
    setError(null)
    rebaseWorkspace.mutate(workspaceId, {
      onError: (err: unknown) => {
        handleMutationError(err, t('更新失败，请稍后重试'), (details) => onConflict(details), setError)
      },
    })
  }

  const handleOpenSubmitDialog = () => {
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

  // --- Main status view ---
  if (noChanges) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground border-b border-border/60">
        <Info size={13} className="shrink-0 text-muted-foreground/70" />
        <span className="text-xs">{t('当前分支还没有任何变更')}</span>
      </div>
    )
  }

  return (
    <>
      <div className="border-b border-border bg-background">
        <div className="px-3 py-2">
          {error && (
            <Notice tone="danger" size="sm" className="mb-2">{error}</Notice>
          )}

          {isDirty && (
            <Notice tone="warning" size="sm" icon={<FileWarning />} className="mb-2">
              {t('{count} 个本地改动未处理，需要先整理后再继续', { count: dirtyCount })}
            </Notice>
          )}

          {hasConflicts && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs text-foreground">
                <AlertTriangle size={13} className="shrink-0 text-warning" />
                <span>{t('{count} 个文件存在冲突，需要处理后继续', { count: gitStatus.conflictedFiles.length })}</span>
              </div>
              <div className="flex items-center gap-1.5 ml-auto">
                <Button variant="primary" size="sm" onClick={onResolveConflicts}>
                  {t('处理冲突')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => abortOperation.mutate(workspaceId)}
                  loading={abortOperation.isPending}
                >
                  {abortOperation.isPending ? t('正在撤销...') : t('撤销操作')}
                </Button>
              </div>
            </div>
          )}

          {isOperationInProgress && !hasConflicts && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs text-foreground">
                <Spinner size="xs" className="text-info" />
                <span>{gitStatus.operation === 'rebase' ? t('正在同步源分支更新...') : t('正在提交变更...')}</span>
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="ml-auto"
                onClick={() => abortOperation.mutate(workspaceId)}
                loading={abortOperation.isPending}
              >
                {!abortOperation.isPending && <XCircle />}
                {abortOperation.isPending ? t('正在撤销...') : t('撤销操作')}
              </Button>
            </div>
          )}

          {!hasConflicts && !isOperationInProgress && (gitStatus.behind > 0 || gitStatus.ahead > 0) && (
            <div className="flex items-center gap-3 flex-wrap">
              {gitStatus.behind > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t('源分支 {branch} 有 {count} 个更新', { branch: targetBranch, count: gitStatus.behind })}
                  </span>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleUpdate}
                    disabled={!canUpdate}
                    loading={rebaseWorkspace.isPending}
                  >
                    {!rebaseWorkspace.isPending && <RefreshCw />}
                    {rebaseWorkspace.isPending ? t('正在同步...') : t('同步更新')}
                  </Button>
                </div>
              )}

              {gitStatus.ahead > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t('{count} 个文件变更，可以安全提交', { count: committedFileCount ?? gitStatus.ahead })}
                  </span>
                  <span
                    title={canSubmit ? undefined : t('需要先处理本地改动')}
                    className={cn('inline-flex', !canSubmit && 'cursor-not-allowed')}
                  >
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleOpenSubmitDialog}
                      disabled={!canSubmit || mergeWorkspace.isPending}
                    >
                      <Upload />
                      {t('提交变更')}
                    </Button>
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Submit confirmation dialog */}
      <SubmitChangesDialog
        projectId={projectId}
        workspaceId={workspaceId}
        canMerge={canUpdate && gitStatus.ahead > 0 && gitStatus.behind === 0}
        isOpen={isSubmitDialogOpen}
        onClose={handleCloseSubmitDialog}
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
