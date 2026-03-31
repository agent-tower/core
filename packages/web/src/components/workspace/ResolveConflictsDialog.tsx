import { useState } from 'react'
import type { ConflictOp, Session } from '@agent-tower/shared'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { buildResolveConflictsInstructions } from '@/lib/conflict-instructions'
import { useSendMessage } from '@/hooks/use-sessions'
import { useOpenInEditor } from '@/hooks/use-workspaces'
import { useI18n } from '@/lib/i18n'

interface ResolveConflictsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  conflictOp: ConflictOp
  conflictedFiles: string[]
  sourceBranch: string
  targetBranch: string
  sessions: Session[]
}

export function ResolveConflictsDialog({
  open,
  onOpenChange,
  workspaceId,
  conflictOp,
  conflictedFiles,
  sourceBranch,
  targetBranch,
  sessions,
}: ResolveConflictsDialogProps) {
  const { t } = useI18n()
  const [selectedSessionId, setSelectedSessionId] = useState<string>('')
  const sendMessage = useSendMessage()
  const openInEditor = useOpenInEditor()

  const handleAiResolve = () => {
    if (!selectedSessionId) return
    const instructions = buildResolveConflictsInstructions(
      sourceBranch,
      targetBranch,
      conflictedFiles,
      conflictOp
    )
    sendMessage.mutate(
      { id: selectedSessionId, message: instructions },
      { onSuccess: () => onOpenChange(false) }
    )
  }

  const handleManualResolve = () => {
    openInEditor.mutate(
      { workspaceId },
      { onSuccess: () => onOpenChange(false) }
    )
  }

  const opLabel = conflictOp === 'REBASE' ? 'Rebase' : 'Merge'

  return (
    <Modal
      isOpen={open}
      onClose={() => onOpenChange(false)}
      title={t('解决 {opLabel} 冲突', { opLabel })}
      action={
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleManualResolve}>
            {t('在 IDE 中打开')}
          </Button>
          <Button
            onClick={handleAiResolve}
            disabled={!selectedSessionId || sendMessage.isPending}
          >
            {sendMessage.isPending ? t('发送中...') : t('AI 辅助解决')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* 冲突文件列表 */}
        <div>
          <h4 className="text-sm font-medium text-neutral-700 mb-2">
            {t('冲突文件（{count}）', { count: conflictedFiles.length })}
          </h4>
          <div className="max-h-40 overflow-y-auto rounded-md border border-neutral-200 bg-neutral-50">
            {conflictedFiles.map((file) => (
              <div
                key={file}
                className="px-3 py-1.5 text-xs font-mono text-neutral-700 border-b border-neutral-100 last:border-b-0"
              >
                {file}
              </div>
            ))}
          </div>
        </div>

        {/* Session 选择 */}
        {sessions.length > 0 && (
          <div>
            <h4 className="text-sm font-medium text-neutral-700 mb-2">
              {t('选择 Session（AI 辅助解决）')}
            </h4>
            <select
              value={selectedSessionId}
              onChange={(e) => setSelectedSessionId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-neutral-300"
            >
              <option value="">{t('选择一个 Session...')}</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.agentType} — {s.status}
                </option>
              ))}
            </select>
          </div>
        )}

        {sessions.length === 0 && (
          <p className="text-sm text-neutral-500">
            {t('没有可用的 Session，请在 IDE 中手动解决冲突。')}
          </p>
        )}
      </div>
    </Modal>
  )
}
