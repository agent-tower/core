import { useId, useState } from 'react'
import { Upload } from 'lucide-react'
import type { WorkspaceBackgroundServiceDto } from '@agent-tower/shared'
import { useI18n } from '@/lib/i18n'
import { Modal } from '@/components/ui/modal'
import { Button, Field, Notice, Textarea } from '@/design-system'
import { BranchFlow } from './BranchFlow'
import { MergeActiveServicesNotice } from './MergeActiveServicesNotice'
import { useProjectWorkspaceBranches, useUpdateWorkspaceBaseBranch } from '@/hooks/use-workspaces'
import { ApiError } from '@/lib/api-client'
import { toast } from 'sonner'
import { BranchSelect } from '@/components/project/BranchSelect'

const baseBranchErrors: Record<string, string> = {
  INVALID_BASE_BRANCH: 'Choose an existing local branch different from the workspace branch.',
  BASE_BRANCH_UNRELATED: 'The selected branch has no shared commit history with this workspace.',
  WORKSPACE_BASE_BRANCH_BUSY: 'Wait for the Agent to finish or stop it before changing the base branch.',
  WORKSPACE_GIT_OPERATION_IN_PROGRESS: 'Finish or abort the current Git operation before changing the base branch.',
  WORKSPACE_BASE_BRANCH_CHANGED: 'The workspace changed. Refresh and select the base branch again.',
  INVALID_WORKSPACE_STATE: 'Only active workspaces can change base branch. Refresh the list.',
  WORKSPACE_BASE_BRANCH_MANAGED: 'TeamRun member base branches are managed by their parent workspace.',
}

export interface SubmitChangesDialogProps {
  isOpen: boolean
  onClose: () => void
  onBaseBranchSaved?: () => void
  projectId: string
  workspaceId: string
  branchName: string
  targetBranch: string
  /** AI 生成的初始提交消息（用户编辑后不再覆盖） */
  commitMessage?: string | null
  isPending: boolean
  canMerge: boolean
  activeServices: WorkspaceBackgroundServiceDto[]
  isCheckingServices: boolean
  serviceCheckFailed: boolean
  error?: string | null
  onConfirm: (message: string | undefined, stopActiveServices: boolean) => void
}

/** 提交变更确认弹窗：分支流向 + 可编辑提交消息（GitStatusBar 与 header Git 菜单共用） */
export function SubmitChangesDialog(props: SubmitChangesDialogProps) {
  return props.isOpen ? <SubmitChangesForm key={props.workspaceId} {...props} /> : null
}

function SubmitChangesForm({
  isOpen,
  onClose,
  onBaseBranchSaved,
  projectId,
  workspaceId,
  branchName,
  targetBranch,
  commitMessage,
  isPending,
  canMerge,
  activeServices,
  isCheckingServices,
  serviceCheckFailed,
  error,
  onConfirm,
}: SubmitChangesDialogProps) {
  const { t } = useI18n()
  const selectId = useId()
  const branchesQuery = useProjectWorkspaceBranches(projectId)
  const updateBaseBranch = useUpdateWorkspaceBaseBranch()
  const workspace = branchesQuery.data?.workspaces.find((item) => item.id === workspaceId)
  const currentBaseBranch = workspace?.baseBranch || branchesQuery.data?.mainBranch || targetBranch
  const [baseBranchDraft, setBaseBranchDraft] = useState<string | null>(null)
  const baseBranch = baseBranchDraft ?? currentBaseBranch
  const availableBranches = branchesQuery.data?.branches.filter((name) => name !== branchName) ?? []
  const hasBranchChange = !!workspace && baseBranch !== currentBaseBranch
  const isBusy = isPending || updateBaseBranch.isPending
  const branchesUnavailable = branchesQuery.isPending || branchesQuery.isFetching || branchesQuery.isError
  const baseBranchError = updateBaseBranch.error instanceof ApiError ? String(updateBaseBranch.error.details.code) : ''
  const [messageDraft, setMessageDraft] = useState<string | null>(null)
  const editableMessage = messageDraft ?? commitMessage ?? ''

  const handleClose = () => {
    if (isBusy) return
    onClose()
  }

  const saveBaseBranch = async () => {
    if (!workspace || !hasBranchChange) return
    try {
      await updateBaseBranch.mutateAsync({ id: workspaceId, baseBranch, expectedBaseBranch: workspace.baseBranch })
      toast.success(t('Workspace base branch saved. Review the changes before merging.'))
      onClose()
      onBaseBranchSaved?.()
    } catch { /* Mutation state displays the error below. */ }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('提交变更')}
      className="max-w-md"
      action={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={isBusy}>
            {t('取消')}
          </Button>
          <Button
            variant="primary"
            onClick={() => onConfirm(editableMessage.trim() || undefined, activeServices.length > 0)}
            disabled={isBusy || isCheckingServices || branchesUnavailable || hasBranchChange || !canMerge}
            loading={isPending || isCheckingServices}
          >
            {isPending || isCheckingServices ? (
              isCheckingServices
                ? t('正在检查后台服务...')
                : activeServices.length > 0
                  ? t('正在停止服务并提交...')
                  : t('正在提交...')
            ) : (
              <>
                <Upload />
                {activeServices.length > 0 ? t('停止服务并提交') : t('确认提交')}
              </>
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <BranchFlow from={branchName} to={workspace ? currentBaseBranch : targetBranch} />

        {branchesQuery.isPending ? <p className="text-xs text-muted-foreground">{t('Loading...')}</p> : branchesQuery.isError ? (
          <div className="space-y-2">
            <p role="alert" className="text-xs text-destructive-ink">{t('Could not load branches. Refresh to try again.')}</p>
            <Button size="sm" onClick={() => void branchesQuery.refetch()}>{t('Refresh')}</Button>
          </div>
        ) : workspace && (
          <div className="space-y-2">
            <label htmlFor={selectId} className="block text-[13px] font-medium text-foreground">{t('Base branch for this workspace')}</label>
            <BranchSelect id={selectId} label={t('Base branch for this workspace')} value={baseBranch} branches={availableBranches}
              disabled={isBusy} isRefreshing={branchesQuery.isFetching} onOpen={() => void branchesQuery.refetch()} onChange={(value) => {
                setBaseBranchDraft(value)
                updateBaseBranch.reset()
              }} />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('Changing this base branch updates the comparison, update and merge target for this workspace only. Save and review the changes before merging.')}
            </p>
            {hasBranchChange && (
              <Button variant="primary" size="sm" onClick={() => void saveBaseBranch()} disabled={isBusy || branchesUnavailable || !availableBranches.includes(baseBranch)}>
                {updateBaseBranch.isPending ? t('Saving') : t('Save base branch and review changes')}
              </Button>
            )}
            {updateBaseBranch.isError && <p role="alert" className="text-xs text-destructive-ink">{t(baseBranchErrors[baseBranchError] ?? 'Could not save the base branch. Refresh and try again.')}</p>}
          </div>
        )}

        {!canMerge && <p className="text-xs text-muted-foreground">{t('Review the changes and sync the base branch before submitting.')}</p>}

        <Field
          label={t('提交消息')}
          description={
            <>
              {t('建议以 feat、fix、docs、refactor、chore 开头，保持提交记录清晰。feat 新增功能，fix 修复问题，docs 文档更新，refactor 代码重构，chore 日常维护。')}
              {!editableMessage.trim() && <span className="mt-1 block">{t('留空将使用默认消息')}</span>}
            </>
          }
        >
          <Textarea
            value={editableMessage}
            onChange={(e) => setMessageDraft(e.target.value)}
            placeholder={t('请描述本次修改的内容')}
            minRows={4}
            className="font-mono"
          />
        </Field>

        <MergeActiveServicesNotice
          services={activeServices}
          isLoading={isCheckingServices}
          isError={serviceCheckFailed}
        />

        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  )
}
