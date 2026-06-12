import { useState, useEffect } from 'react'
import {
  Loader2, AlertTriangle,
  RefreshCw, Upload, XCircle, FileWarning, Info,
} from 'lucide-react'
import { useRebaseWorkspace, useMergeWorkspace, useAbortOperation, useGitStatus } from '@/hooks/use-workspaces'
import { useI18n } from '@/lib/i18n'
import { SubmitChangesDialog } from './SubmitChangesDialog'
import { getConflictDetails, type ConflictDetails } from './GitOperationsDialog'

export interface GitStatusBarProps {
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

  useEffect(() => {
    if (isSubmitDialogOpen) {
      void onRefreshCommitMessage?.()
    }
  }, [isSubmitDialogOpen, onRefreshCommitMessage])

  if (isLoading || !gitStatus) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground/70 border-b border-border/60">
        <Loader2 size={14} className="animate-spin" />
        <span className="text-xs">{t('正在检查工作区状态...')}</span>
      </div>
    )
  }

  const hasConflicts = gitStatus.conflictedFiles.length > 0
  const isOperationInProgress = gitStatus.operation !== 'idle'
  const isDirty = gitStatus.hasUncommittedChanges || gitStatus.untrackedCount > 0
  const dirtyCount = gitStatus.uncommittedCount + gitStatus.untrackedCount
  const canUpdate = !hasConflicts && !isOperationInProgress && !isDirty
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

  // --- Main status view ---
  if (noChanges) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground/70 border-b border-border/60">
        <Info size={13} />
        <span className="text-xs">{t('当前分支还没有任何变更')}</span>
      </div>
    )
  }

  return (
    <>
      <div className="border-b border-border bg-background">
        <div className="px-3 py-2">
          {error && (
            <div className="mb-2 px-2.5 py-1.5 rounded-md bg-red-50 border border-red-200 text-[11px] text-red-700">
              {error}
            </div>
          )}

          {isDirty && (
            <div className="flex items-center gap-2 mb-2 px-2.5 py-1.5 rounded-md bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
              <FileWarning size={12} className="shrink-0" />
              <span>
                {t('{count} 个本地改动未处理，需要先整理后再继续', { count: dirtyCount })}
              </span>
            </div>
          )}

          {hasConflicts && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs text-amber-700">
                <AlertTriangle size={13} className="shrink-0" />
                <span>{t('{count} 个文件存在冲突，需要处理后继续', { count: gitStatus.conflictedFiles.length })}</span>
              </div>
              <div className="flex items-center gap-1.5 ml-auto">
                <button
                  onClick={onResolveConflicts}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-amber-800 bg-amber-100 hover:bg-amber-200 border border-amber-200 transition-colors"
                >
                  {t('处理冲突')}
                </button>
                <button
                  onClick={() => abortOperation.mutate(workspaceId)}
                  disabled={abortOperation.isPending}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:bg-muted border border-border transition-colors disabled:opacity-50"
                >
                  {abortOperation.isPending ? t('正在撤销...') : t('撤销操作')}
                </button>
              </div>
            </div>
          )}

          {isOperationInProgress && !hasConflicts && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs text-info">
                <Loader2 size={13} className="animate-spin shrink-0" />
                <span>{gitStatus.operation === 'rebase' ? t('正在同步源分支更新...') : t('正在提交变更...')}</span>
              </div>
              <button
                onClick={() => abortOperation.mutate(workspaceId)}
                disabled={abortOperation.isPending}
                className="flex items-center gap-1.5 ml-auto px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:bg-muted border border-border transition-colors disabled:opacity-50"
              >
                <XCircle size={12} />
                {abortOperation.isPending ? t('正在撤销...') : t('撤销操作')}
              </button>
            </div>
          )}

          {!hasConflicts && !isOperationInProgress && (gitStatus.behind > 0 || gitStatus.ahead > 0) && (
            <div className="flex items-center gap-3 flex-wrap">
              {gitStatus.behind > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t('源分支 {branch} 有 {count} 个更新', { branch: targetBranch, count: gitStatus.behind })}
                  </span>
                  <button
                    onClick={handleUpdate}
                    disabled={!canUpdate || rebaseWorkspace.isPending}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={12} />
                    {rebaseWorkspace.isPending ? t('正在同步...') : t('同步更新')}
                  </button>
                </div>
              )}

              {gitStatus.ahead > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t('{count} 个文件变更，可以安全提交', { count: committedFileCount ?? gitStatus.ahead })}
                  </span>
                  {gitStatus.behind === 0 && !isDirty ? (
                    <button
                      onClick={handleOpenSubmitDialog}
                      disabled={mergeWorkspace.isPending}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      <Upload size={12} />
                      {t('提交变更')}
                    </button>
                  ) : (
                    <button
                      disabled
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground/60 bg-muted/60 border border-border cursor-not-allowed"
                      title={isDirty ? t('需要先处理本地改动') : t('需要先同步源分支更新')}
                    >
                      <Upload size={12} />
                      {t('提交变更')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Submit confirmation dialog */}
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
