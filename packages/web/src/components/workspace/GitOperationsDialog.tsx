import { useState, useEffect } from 'react'
import { GitBranch, GitMerge, AlertTriangle, CheckCircle, FileWarning } from 'lucide-react'
import {
  ConflictOp,
  type GitOperationStatus,
  type WorkspaceBackgroundServiceDto,
} from '@agent-tower/shared'
import { Modal } from '@/components/ui/modal'
import { Badge, Button, Field, Notice, Spinner, Textarea } from '@/design-system'
import { useRebaseWorkspace, useMergeWorkspace, useGitStatus } from '@/hooks/use-workspaces'
import { useWorkspaceBackgroundServices } from '@/hooks/use-workspace-services'
import { useI18n } from '@/lib/i18n'
import { ApiError } from '@/lib/api-client'
import {
  isMergeBlockingWorkspaceService,
  isWorkspaceServiceMergeError,
} from '@/lib/workspace-merge'
import { BranchFlow } from './BranchFlow'
import { MergeActiveServicesNotice } from './MergeActiveServicesNotice'

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
  onConflict: (details?: ConflictDetails) => void
}

type MergeStep = 'select' | 'confirm'

export interface ConflictDetails {
  conflictOp: ConflictOp
  conflictedFiles: string[]
  mergeAborted?: boolean
  mergeStrategy?: 'squash' | 'no_ff'
  sourceBranch?: string
  targetBranch?: string
  sourceWorktreePath?: string
  targetWorktreePath?: string
  sourceWorkspaceId?: string
  targetWorkspaceId?: string
}

function getOptionalString(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function getConflictDetails(error: unknown): ConflictDetails | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined

  const details = error.details
  if (details.code !== 'MERGE_CONFLICT') return undefined
  if (details.conflictOp !== ConflictOp.REBASE && details.conflictOp !== ConflictOp.MERGE) return undefined
  if (!Array.isArray(details.conflictedFiles)) return undefined
  if (!details.conflictedFiles.every((file): file is string => typeof file === 'string')) return undefined

  const mergeStrategy = details.mergeStrategy === 'squash' || details.mergeStrategy === 'no_ff'
    ? details.mergeStrategy
    : undefined

  return {
    conflictOp: details.conflictOp,
    conflictedFiles: details.conflictedFiles,
    mergeAborted: typeof details.mergeAborted === 'boolean' ? details.mergeAborted : undefined,
    mergeStrategy,
    sourceBranch: getOptionalString(details, 'sourceBranch'),
    targetBranch: getOptionalString(details, 'targetBranch'),
    sourceWorktreePath: getOptionalString(details, 'sourceWorktreePath'),
    targetWorktreePath: getOptionalString(details, 'targetWorktreePath'),
    sourceWorkspaceId: getOptionalString(details, 'sourceWorkspaceId'),
    targetWorkspaceId: getOptionalString(details, 'targetWorkspaceId'),
  }
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

/** 操作选项：整张卡片可点，图标放在浅灰方块里（颜色只留给状态） */
const OPTION_BUTTON = 'w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-border enabled:hover:bg-accent transition-colors text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40 disabled:cursor-not-allowed'
const OPTION_ICON = 'w-8 h-8 rounded-md bg-foreground/[0.05] text-foreground/80 flex items-center justify-center shrink-0'


function BranchStatusInfo({ gitStatus, branchName, targetBranch }: {
  gitStatus: GitOperationStatus
  branchName: string
  targetBranch: string
}) {
  const { t } = useI18n()
  return (
    <div className="space-y-4">
      <BranchFlow from={branchName} to={targetBranch} />

      <div className="flex flex-wrap gap-2">
        {gitStatus.hasUncommittedChanges && (
          <Badge tone="danger">
            <FileWarning size={12} />
            {t('{count} 个未提交变更', { count: gitStatus.uncommittedCount })}
          </Badge>
        )}
        {gitStatus.conflictedFiles.length > 0 && (
          <Badge tone="warning">
            <AlertTriangle size={12} />
            {t('{count} 个冲突文件', { count: gitStatus.conflictedFiles.length })}
          </Badge>
        )}
        {gitStatus.operation === 'rebase' && gitStatus.conflictedFiles.length === 0 && (
          <Badge tone="warning">
            <Spinner size="xs" />
            {t('变基进行中')}
          </Badge>
        )}
        {gitStatus.operation === 'merge' && gitStatus.conflictedFiles.length === 0 && (
          <Badge tone="warning">
            <Spinner size="xs" />
            {t('合并进行中')}
          </Badge>
        )}
        {gitStatus.ahead > 0 && (
          <Badge tone="success">
            <CheckCircle size={12} />
            {t('领先 {count} 个提交', { count: gitStatus.ahead })}
          </Badge>
        )}
        {gitStatus.behind > 0 && (
          <Badge tone="warning">
            {t('落后 {count} 个提交', { count: gitStatus.behind })}
          </Badge>
        )}
        {gitStatus.operation === 'idle' && gitStatus.ahead === 0 && gitStatus.behind === 0 && !gitStatus.hasUncommittedChanges && (
          <Badge tone="neutral">
            <CheckCircle size={12} />
            {t('已是最新')}
          </Badge>
        )}
      </div>

      {gitStatus.hasUncommittedChanges && (
        <Notice tone="warning">
          {t('工作区有未提交的变更，请先让 Agent 提交或手动处理后再执行 Rebase / Merge 操作。')}
        </Notice>
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
  const servicesQuery = useWorkspaceBackgroundServices(
    workspaceId,
    open && mergeStep === 'confirm',
  )
  const activeServices = (servicesQuery.data ?? []).filter(isMergeBlockingWorkspaceService)

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
        handleMutationError(err, t('变基失败'), (details) => {
          onOpenChange(false)
          onConflict(details)
        }, setError)
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
    mergeWorkspace.mutate({
      id: workspaceId,
      commitMessage: finalMessage,
      stopActiveServices: activeServices.length > 0,
    }, {
      onSuccess: () => onOpenChange(false),
      onError: (err: unknown) => {
        if (isWorkspaceServiceMergeError(err)) {
          setError(t('后台服务仍在运行，请确认停止服务后再提交。'))
          return
        }
        handleMutationError(err, t('合并失败'), (details) => {
          onOpenChange(false)
          onConflict(details)
        }, setError)
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
        <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
          <Spinner size="md" />
          <span className="text-sm">{t('加载分支状态...')}</span>
        </div>
      ) : mergeStep === 'confirm' ? (
        <MergeConfirmView
          editableMessage={editableMessage}
          setEditableMessage={handleEditableMessageChange}
          error={error}
          isPending={mergeWorkspace.isPending}
          activeServices={activeServices}
          isCheckingServices={servicesQuery.isLoading}
          serviceCheckFailed={servicesQuery.isError}
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
        <Notice tone="danger">{error}</Notice>
      )}

      <div className="space-y-2">
        <button
          type="button"
          onClick={onRebase}
          disabled={rebasePending || hasConflicts || isOperationInProgress || isDirty}
          className={OPTION_BUTTON}
        >
          <div className={OPTION_ICON}>
            <GitBranch size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              {rebasePending ? t('变基中...') : t('变基 (Rebase)')}
            </div>
            <div className="text-xs text-muted-foreground">{t('将当前分支变基到最新的 {targetBranch}', { targetBranch })}</div>
          </div>
        </button>

        <button
          type="button"
          onClick={onMerge}
          disabled={mergePending || hasConflicts || isOperationInProgress || isDirty || gitStatus.ahead === 0}
          className={OPTION_BUTTON}
        >
          <div className={OPTION_ICON}>
            <GitMerge size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              {mergePending ? t('合并中...') : t('合并 (Merge)')}
            </div>
            <div className="text-xs text-muted-foreground">{t('合并到 {targetBranch}', { targetBranch })}</div>
          </div>
        </button>
      </div>
    </div>
  )
}

function MergeConfirmView({
  editableMessage, setEditableMessage,
  error, isPending, activeServices, isCheckingServices, serviceCheckFailed,
  onConfirm, onBack, branchName, targetBranch,
}: {
  editableMessage: string
  setEditableMessage: (v: string) => void
  error: string | null
  isPending: boolean
  activeServices: WorkspaceBackgroundServiceDto[]
  isCheckingServices: boolean
  serviceCheckFailed: boolean
  onConfirm: () => void
  onBack: () => void
  branchName: string
  targetBranch: string
}) {
  const { t } = useI18n()
  return (
    <div className="space-y-4">
      {/* Branch info */}
      <BranchFlow from={branchName} to={targetBranch} />

      {/* Commit message editor */}
      <Field label={t('提交消息')} description={!editableMessage.trim() ? t('留空将使用默认消息') : undefined}>
        <Textarea
          value={editableMessage}
          onChange={(e) => setEditableMessage(e.target.value)}
          placeholder={t('输入提交消息...')}
          minRows={4}
          className="font-mono"
        />
      </Field>

      <MergeActiveServicesNotice
        services={activeServices}
        isLoading={isCheckingServices}
        isError={serviceCheckFailed}
      />

      {error && (
        <Notice tone="danger">{error}</Notice>
      )}

      {/* Actions */}
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" onClick={onBack} disabled={isPending}>
          {t('返回')}
        </Button>
        <Button variant="primary" onClick={onConfirm} loading={isPending || isCheckingServices}>
          {isPending || isCheckingServices ? (
            isCheckingServices
              ? t('正在检查后台服务...')
              : activeServices.length > 0
                ? t('正在停止服务并提交...')
                : t('合并中...')
          ) : (
            <>
              <GitMerge />
              {activeServices.length > 0 ? t('停止服务并提交') : t('确认合并')}
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
