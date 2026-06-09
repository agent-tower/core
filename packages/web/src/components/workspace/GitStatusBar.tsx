import { useState, useEffect } from 'react'
import {
  ArrowRight, Loader2, AlertTriangle,
  RefreshCw, Upload, XCircle, FileWarning, Info,
} from 'lucide-react'
import { useRebaseWorkspace, useMergeWorkspace, useAbortOperation, useGitStatus } from '@/hooks/use-workspaces'
import { useI18n } from '@/lib/i18n'
import { Modal } from '@/components/ui/modal'
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
  const [editableMessage, setEditableMessage] = useState('')
  const [hasEditedMessage, setHasEditedMessage] = useState(false)

  useEffect(() => {
    if (hasEditedMessage) return
    setEditableMessage(commitMessage ?? '')
  }, [commitMessage, hasEditedMessage])

  useEffect(() => {
    if (isSubmitDialogOpen) {
      void onRefreshCommitMessage?.()
    }
  }, [isSubmitDialogOpen, onRefreshCommitMessage])

  if (isLoading || !gitStatus) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-neutral-400 border-b border-neutral-100">
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
    setHasEditedMessage(false)
    setEditableMessage(commitMessage ?? '')
    setIsSubmitDialogOpen(true)
  }

  const handleSubmitConfirm = () => {
    setError(null)
    const finalMessage = editableMessage.trim() || undefined
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
      <div className="flex items-center gap-2 px-3 py-2 text-neutral-400 border-b border-neutral-100">
        <Info size={13} />
        <span className="text-xs">{t('当前分支还没有任何变更')}</span>
      </div>
    )
  }

  return (
    <>
      <div className="border-b border-neutral-200 bg-white">
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
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-neutral-600 hover:bg-neutral-100 border border-neutral-200 transition-colors disabled:opacity-50"
                >
                  {abortOperation.isPending ? t('正在撤销...') : t('撤销操作')}
                </button>
              </div>
            </div>
          )}

          {isOperationInProgress && !hasConflicts && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs text-blue-700">
                <Loader2 size={13} className="animate-spin shrink-0" />
                <span>{gitStatus.operation === 'rebase' ? t('正在同步源分支更新...') : t('正在提交变更...')}</span>
              </div>
              <button
                onClick={() => abortOperation.mutate(workspaceId)}
                disabled={abortOperation.isPending}
                className="flex items-center gap-1.5 ml-auto px-2.5 py-1 rounded-md text-xs text-neutral-600 hover:bg-neutral-100 border border-neutral-200 transition-colors disabled:opacity-50"
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
                  <span className="text-xs text-neutral-600">
                    {t('源分支 {branch} 有 {count} 个更新', { branch: targetBranch, count: gitStatus.behind })}
                  </span>
                  <button
                    onClick={handleUpdate}
                    disabled={!canUpdate || rebaseWorkspace.isPending}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={12} />
                    {rebaseWorkspace.isPending ? t('正在同步...') : t('同步更新')}
                  </button>
                </div>
              )}

              {gitStatus.ahead > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-600">
                    {t('{count} 个文件变更，可以安全提交', { count: committedFileCount ?? gitStatus.ahead })}
                  </span>
                  {gitStatus.behind === 0 && !isDirty ? (
                    <button
                      onClick={handleOpenSubmitDialog}
                      disabled={mergeWorkspace.isPending}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 transition-colors disabled:opacity-50"
                    >
                      <Upload size={12} />
                      {t('提交变更')}
                    </button>
                  ) : (
                    <button
                      disabled
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-neutral-400 bg-neutral-50 border border-neutral-200 cursor-not-allowed"
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
      <Modal
        isOpen={isSubmitDialogOpen}
        onClose={handleCloseSubmitDialog}
        title={t('提交变更')}
        className="max-w-md"
        action={
          <>
            <button
              onClick={handleCloseSubmitDialog}
              disabled={mergeWorkspace.isPending}
              className="px-4 py-2 text-sm font-medium text-neutral-600 hover:text-neutral-900 transition-colors disabled:opacity-50"
            >
              {t('取消')}
            </button>
            <button
              onClick={handleSubmitConfirm}
              disabled={mergeWorkspace.isPending}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors disabled:opacity-50"
            >
              {mergeWorkspace.isPending ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {t('正在提交...')}
                </>
              ) : (
                <>
                  <Upload size={14} />
                  {t('确认提交')}
                </>
              )}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="px-2 py-0.5 rounded bg-neutral-100 font-mono text-xs text-neutral-700">{branchName}</span>
            <ArrowRight size={14} className="text-neutral-400 shrink-0" />
            <span className="px-2 py-0.5 rounded bg-neutral-100 font-mono text-xs text-neutral-700">{targetBranch}</span>
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-700 mb-1.5">
              {t('提交消息')}
            </label>
            <textarea
              value={editableMessage}
              onChange={(e) => {
                setHasEditedMessage(true)
                setEditableMessage(e.target.value)
              }}
              placeholder={t('请描述本次修改的内容')}
              rows={4}
              className="w-full px-3 py-2 rounded-lg border border-neutral-200 text-sm font-mono text-neutral-800 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-300 resize-none"
            />
            <p className="mt-1.5 text-[11px] text-neutral-400 leading-relaxed">
              {t('建议以 feat、fix、docs、refactor、chore 开头，保持提交记录清晰。feat 新增功能，fix 修复问题，docs 文档更新，refactor 代码重构，chore 日常维护。')}
            </p>
            {!editableMessage.trim() && (
              <p className="mt-1 text-[11px] text-neutral-400">{t('留空将使用默认消息')}</p>
            )}
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}
