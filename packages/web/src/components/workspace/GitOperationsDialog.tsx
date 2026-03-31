import { useState, useEffect } from 'react'
import { GitBranch, GitMerge, AlertTriangle, CheckCircle, ArrowRight, Loader2, FileWarning } from 'lucide-react'
import type { GitOperationStatus } from '@agent-tower/shared'
import { Modal } from '@/components/ui/modal'
import { useRebaseWorkspace, useMergeWorkspace, useGitStatus } from '@/hooks/use-workspaces'
import { useI18n } from '@/lib/i18n'

interface GitOperationsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  branchName: string
  targetBranch: string
  /** AI 生成的 commit message（缓存在 workspace 上） */
  commitMessage?: string | null
  /** 打开弹窗时补拉一次 workspace，兜底隐藏 session 造成的缓存延迟 */
  onRefreshCommitMessage?: () => void | Promise<unknown>
  onConflict: () => void
}

type MergeStep = 'select' | 'confirm'

function StatusChip({ children, variant }: {
  children: React.ReactNode
  variant: 'success' | 'warning' | 'info' | 'neutral' | 'danger'
}) {
  const styles = {
    success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    warning: 'bg-amber-50 text-amber-700 border-amber-200',
    info: 'bg-blue-50 text-blue-700 border-blue-200',
    neutral: 'bg-neutral-50 text-neutral-600 border-neutral-200',
    danger: 'bg-red-50 text-red-700 border-red-200',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${styles[variant]}`}>
      {children}
    </span>
  )
}

function BranchStatusInfo({ gitStatus, branchName, targetBranch }: {
  gitStatus: GitOperationStatus
  branchName: string
  targetBranch: string
}) {
  const { t } = useI18n()
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="px-2.5 py-1 rounded-md bg-neutral-100 font-mono text-xs text-neutral-700">{branchName}</span>
        <ArrowRight size={14} className="text-neutral-400" />
        <span className="px-2.5 py-1 rounded-md bg-neutral-100 font-mono text-xs text-neutral-700">{targetBranch}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {gitStatus.hasUncommittedChanges && (
          <StatusChip variant="danger">
            <FileWarning size={12} />
            {t('{count} 个未提交变更', { count: gitStatus.uncommittedCount })}
          </StatusChip>
        )}
        {gitStatus.conflictedFiles.length > 0 && (
          <StatusChip variant="warning">
            <AlertTriangle size={12} />
            {t('{count} 个冲突文件', { count: gitStatus.conflictedFiles.length })}
          </StatusChip>
        )}
        {gitStatus.operation === 'rebase' && gitStatus.conflictedFiles.length === 0 && (
          <StatusChip variant="warning">
            <Loader2 size={12} className="animate-spin" />
            {t('变基进行中')}
          </StatusChip>
        )}
        {gitStatus.operation === 'merge' && gitStatus.conflictedFiles.length === 0 && (
          <StatusChip variant="warning">
            <Loader2 size={12} className="animate-spin" />
            {t('合并进行中')}
          </StatusChip>
        )}
        {gitStatus.ahead > 0 && (
          <StatusChip variant="success">
            <CheckCircle size={12} />
            {t('领先 {count} 个提交', { count: gitStatus.ahead })}
          </StatusChip>
        )}
        {gitStatus.behind > 0 && (
          <StatusChip variant="warning">
            {t('落后 {count} 个提交', { count: gitStatus.behind })}
          </StatusChip>
        )}
        {gitStatus.operation === 'idle' && gitStatus.ahead === 0 && gitStatus.behind === 0 && !gitStatus.hasUncommittedChanges && (
          <StatusChip variant="neutral">
            <CheckCircle size={12} />
            {t('已是最新')}
          </StatusChip>
        )}
      </div>

      {gitStatus.hasUncommittedChanges && (
        <div className="px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-800">
          {t('工作区有未提交的变更，请先让 Agent 提交或手动处理后再执行 Rebase / Merge 操作。')}
        </div>
      )}
    </div>
  )
}

export function GitOperationsDialog({
  open,
  onOpenChange,
  workspaceId,
  branchName,
  targetBranch,
  commitMessage,
  onRefreshCommitMessage,
  onConflict,
}: GitOperationsDialogProps) {
  const { t } = useI18n()
  const { data: gitStatus, isLoading } = useGitStatus(workspaceId)
  const rebaseWorkspace = useRebaseWorkspace()
  const mergeWorkspace = useMergeWorkspace()
  const [error, setError] = useState<string | null>(null)
  const [mergeStep, setMergeStep] = useState<MergeStep>('select')
  const [editableMessage, setEditableMessage] = useState('')
  const [hasEditedMessage, setHasEditedMessage] = useState(false)

  const hasConflicts = gitStatus ? gitStatus.conflictedFiles.length > 0 : false
  const isOperationInProgress = gitStatus ? gitStatus.operation !== 'idle' : false
  const isDirty = gitStatus?.hasUncommittedChanges ?? false

  // 打开弹窗时重置状态，并补拉一次 workspace 数据兜底。
  useEffect(() => {
    if (open) {
      setMergeStep('select')
      setError(null)
      setHasEditedMessage(false)
      void onRefreshCommitMessage?.()
    }
  }, [open, onRefreshCommitMessage])

  // 仅在用户尚未手动编辑时，同步后端最新生成的 commit message。
  useEffect(() => {
    if (!open || hasEditedMessage) return
    setEditableMessage(commitMessage ?? '')
  }, [open, commitMessage, hasEditedMessage])

  const handleEditableMessageChange = (value: React.SetStateAction<string>) => {
    setHasEditedMessage(true)
    setEditableMessage((prev) => (typeof value === 'function' ? value(prev) : value))
  }

  const handleRebase = () => {
    setError(null)
    rebaseWorkspace.mutate(workspaceId, {
      onSuccess: () => onOpenChange(false),
      onError: (err: unknown) => {
        const apiErr = err as { status?: number; message?: string }
        if (apiErr.status === 409) {
          onOpenChange(false)
          onConflict()
        } else {
          setError(apiErr.message ?? t('变基失败'))
        }
      },
    })
  }

  const handleMergeClick = () => {
    setError(null)
    setMergeStep('confirm')
  }

  const handleMergeConfirm = () => {
    setError(null)
    const finalMessage = editableMessage.trim() || undefined
    mergeWorkspace.mutate({ id: workspaceId, commitMessage: finalMessage }, {
      onSuccess: () => onOpenChange(false),
      onError: (err: unknown) => {
        const apiErr = err as { status?: number; message?: string }
        if (apiErr.status === 409) {
          onOpenChange(false)
          onConflict()
        } else {
          setError(apiErr.message ?? t('合并失败'))
        }
      },
    })
  }

  const title = mergeStep === 'confirm' ? t('确认合并') : t('Git 操作')

  return (
    <Modal
      isOpen={open}
      onClose={() => onOpenChange(false)}
      title={title}
    >
      {isLoading || !gitStatus ? (
        <div className="flex items-center justify-center py-8 gap-2 text-neutral-400">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">{t('加载分支状态...')}</span>
        </div>
      ) : mergeStep === 'confirm' ? (
        <MergeConfirmView
          editableMessage={editableMessage}
          setEditableMessage={handleEditableMessageChange}
          error={error}
          isPending={mergeWorkspace.isPending}
          onConfirm={handleMergeConfirm}
          onBack={() => setMergeStep('select')}
          branchName={branchName}
          targetBranch={targetBranch}
        />
      ) : (
        <SelectOperationView
          gitStatus={gitStatus}
          branchName={branchName}
          targetBranch={targetBranch}
          error={error}
          isDirty={isDirty}
          hasConflicts={hasConflicts}
          isOperationInProgress={isOperationInProgress}
          rebasePending={rebaseWorkspace.isPending}
          mergePending={mergeWorkspace.isPending}
          onRebase={handleRebase}
          onMerge={handleMergeClick}
        />
      )}
    </Modal>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function SelectOperationView({
  gitStatus, branchName, targetBranch, error, isDirty, hasConflicts,
  isOperationInProgress, rebasePending, mergePending, onRebase, onMerge,
}: {
  gitStatus: GitOperationStatus
  branchName: string
  targetBranch: string
  error: string | null
  isDirty: boolean
  hasConflicts: boolean
  isOperationInProgress: boolean
  rebasePending: boolean
  mergePending: boolean
  onRebase: () => void
  onMerge: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="space-y-5">
      <BranchStatusInfo gitStatus={gitStatus} branchName={branchName} targetBranch={targetBranch} />

      {error && (
        <div className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-2">
        <button
          onClick={onRebase}
          disabled={rebasePending || hasConflicts || isOperationInProgress || isDirty}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="w-8 h-8 rounded-md bg-blue-50 flex items-center justify-center shrink-0">
            <GitBranch size={16} className="text-blue-600" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-neutral-900">
              {rebasePending ? t('变基中...') : t('变基 (Rebase)')}
            </div>
            <div className="text-xs text-neutral-500">{t('将当前分支变基到最新的 {targetBranch}', { targetBranch })}</div>
          </div>
        </button>

        <button
          onClick={onMerge}
          disabled={mergePending || hasConflicts || isOperationInProgress || isDirty || gitStatus.ahead === 0}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="w-8 h-8 rounded-md bg-emerald-50 flex items-center justify-center shrink-0">
            <GitMerge size={16} className="text-emerald-600" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-neutral-900">
              {mergePending ? t('合并中...') : t('合并 (Merge)')}
            </div>
            <div className="text-xs text-neutral-500">{t('Squash merge 到 {targetBranch}', { targetBranch })}</div>
          </div>
        </button>
      </div>
    </div>
  )
}

function MergeConfirmView({
  editableMessage, setEditableMessage,
  error, isPending, onConfirm, onBack, branchName, targetBranch,
}: {
  editableMessage: string
  setEditableMessage: (v: string) => void
  error: string | null
  isPending: boolean
  onConfirm: () => void
  onBack: () => void
  branchName: string
  targetBranch: string
}) {
  const { t } = useI18n()
  return (
    <div className="space-y-4">
      {/* Branch info */}
      <div className="flex items-center gap-2 text-sm">
        <span className="px-2.5 py-1 rounded-md bg-neutral-100 font-mono text-xs text-neutral-700">{branchName}</span>
        <ArrowRight size={14} className="text-neutral-400" />
        <span className="px-2.5 py-1 rounded-md bg-neutral-100 font-mono text-xs text-neutral-700">{targetBranch}</span>
      </div>

      {/* Commit message editor */}
      <div>
        <label className="block text-xs font-medium text-neutral-600 mb-1.5">
          {t('提交消息')}
        </label>
        <textarea
          value={editableMessage}
          onChange={(e) => setEditableMessage(e.target.value)}
          placeholder={t('输入提交消息...')}
          rows={4}
          className="w-full px-3 py-2 rounded-md border border-neutral-200 text-sm font-mono text-neutral-800 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-300 resize-none"
        />
        {!editableMessage.trim() && (
          <p className="mt-1 text-xs text-neutral-400">
            {t('留空将使用默认消息')}
          </p>
        )}
      </div>

      {error && (
        <div className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 justify-end">
        <button
          onClick={onBack}
          disabled={isPending}
          className="px-4 py-2 rounded-md text-sm text-neutral-600 hover:bg-neutral-100 transition-colors disabled:opacity-50"
        >
          {t('返回')}
        </button>
        <button
          onClick={onConfirm}
          disabled={isPending}
          className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 transition-colors disabled:opacity-50"
        >
          {isPending ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              {t('合并中...')}
            </>
          ) : (
            <>
              <GitMerge size={14} />
              {t('确认合并')}
            </>
          )}
        </button>
      </div>
    </div>
  )
}
