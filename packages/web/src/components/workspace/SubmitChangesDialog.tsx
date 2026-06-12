import { useState, useEffect } from 'react'
import { ArrowRight, Loader2, Upload } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { Modal } from '@/components/ui/modal'

export interface SubmitChangesDialogProps {
  isOpen: boolean
  onClose: () => void
  branchName: string
  targetBranch: string
  /** AI 生成的初始提交消息（用户编辑后不再覆盖） */
  commitMessage?: string | null
  isPending: boolean
  error?: string | null
  onConfirm: (message: string | undefined) => void
}

/** 提交变更确认弹窗：分支流向 + 可编辑提交消息（GitStatusBar 与 header Git 菜单共用） */
export function SubmitChangesDialog({
  isOpen,
  onClose,
  branchName,
  targetBranch,
  commitMessage,
  isPending,
  error,
  onConfirm,
}: SubmitChangesDialogProps) {
  const { t } = useI18n()
  const [editableMessage, setEditableMessage] = useState('')
  const [hasEditedMessage, setHasEditedMessage] = useState(false)

  // 打开时重置为最新生成的消息
  useEffect(() => {
    if (isOpen) {
      setHasEditedMessage(false)
      setEditableMessage(commitMessage ?? '')
    }
  }, [isOpen])

  useEffect(() => {
    if (hasEditedMessage || !isOpen) return
    setEditableMessage(commitMessage ?? '')
  }, [commitMessage, hasEditedMessage, isOpen])

  const handleClose = () => {
    if (isPending) return
    onClose()
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('提交变更')}
      className="max-w-md"
      action={
        <>
          <button
            onClick={handleClose}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            {t('取消')}
          </button>
          <button
            onClick={() => onConfirm(editableMessage.trim() || undefined)}
            disabled={isPending}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-md transition-colors disabled:opacity-50"
          >
            {isPending ? (
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
          <span className="px-2 py-0.5 rounded-sm bg-muted font-mono text-xs text-muted-foreground">{branchName}</span>
          <ArrowRight size={14} className="text-muted-foreground/70 shrink-0" />
          <span className="px-2 py-0.5 rounded-sm bg-muted font-mono text-xs text-muted-foreground">{targetBranch}</span>
        </div>

        <div>
          <label className="block text-xs font-medium text-foreground mb-1.5">
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
            className="w-full px-3 py-2 rounded-md border border-input text-sm font-mono text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring resize-none"
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground/70 leading-relaxed">
            {t('建议以 feat、fix、docs、refactor、chore 开头，保持提交记录清晰。feat 新增功能，fix 修复问题，docs 文档更新，refactor 代码重构，chore 日常维护。')}
          </p>
          {!editableMessage.trim() && (
            <p className="mt-1 text-[11px] text-muted-foreground/70">{t('留空将使用默认消息')}</p>
          )}
        </div>

        {error && (
          <div className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    </Modal>
  )
}
