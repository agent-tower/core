import { useEffect, useState } from 'react'
import type { TeamRunMode } from '@agent-tower/shared'
import { ApiError } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { useCreateTaskTeamRun } from '@/hooks/use-team-run'
import { useI18n } from '@/lib/i18n'
import { TeamRunCreateForm } from './TeamRunCreateForm'

interface CreateTeamRunDialogProps {
  isOpen: boolean
  onClose: () => void
  taskId: string
}

export function CreateTeamRunDialog({ isOpen, onClose, taskId }: CreateTeamRunDialogProps) {
  const { t } = useI18n()
  const [mode, setMode] = useState<TeamRunMode>('AUTO')
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [selectedMemberPresetIds, setSelectedMemberPresetIds] = useState<string[]>([])
  const [submitError, setSubmitError] = useState<string | null>(null)
  const createTeamRun = useCreateTaskTeamRun()

  useEffect(() => {
    if (!isOpen) return
    setMode('AUTO')
    setSelectedTemplateId(null)
    setSelectedMemberPresetIds([])
    setSubmitError(null)
  }, [isOpen])

  const isBusy = createTeamRun.isPending
  const canSubmit = Boolean(selectedTemplateId) || selectedMemberPresetIds.length > 0

  const handleSubmit = async () => {
    if (isBusy) return

    if (!selectedTemplateId && selectedMemberPresetIds.length === 0) {
      setSubmitError(t('请选择至少一个团队模板或成员预设。'))
      return
    }

    setSubmitError(null)

    try {
      await createTeamRun.mutateAsync({
        taskId,
        mode,
        ...(selectedTemplateId ? { teamTemplateId: selectedTemplateId } : {}),
        ...(selectedMemberPresetIds.length > 0 ? { memberPresetIds: selectedMemberPresetIds } : {}),
      })
      onClose()
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setSubmitError(t('该任务已经存在 TeamRun。请刷新后再试。'))
        return
      }
      setSubmitError(error instanceof Error ? error.message : t('创建 TeamRun 失败'))
    }
  }

  const actionDisabled = isBusy || !canSubmit

  return (
    <Modal
      isOpen={isOpen}
      onClose={isBusy ? () => {} : onClose}
      title={t('创建 TeamRun')}
      className="max-w-5xl"
      action={
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={isBusy}>
            {t('取消')}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={actionDisabled}>
            {isBusy ? t('处理中...') : t('创建 TeamRun')}
          </Button>
        </>
      }
    >
      <TeamRunCreateForm
        mode={mode}
        setMode={setMode}
        selectedTemplateId={selectedTemplateId}
        setSelectedTemplateId={setSelectedTemplateId}
        selectedMemberPresetIds={selectedMemberPresetIds}
        setSelectedMemberPresetIds={setSelectedMemberPresetIds}
        disabled={isBusy}
      />

        {submitError && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {submitError}
          </div>
        )}
    </Modal>
  )
}
