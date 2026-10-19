import { useState } from 'react'
import type { ConflictOp, Session } from '@agent-tower/shared'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { Button, Field, Notice, Select } from '@/design-system'
import { buildResolveConflictAiAction } from '@/lib/conflict-instructions'
import { useSendMessage } from '@/hooks/use-sessions'
import { usePostRoomMessage } from '@/hooks/use-team-run'
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
  operation?: 'idle' | 'rebase' | 'merge'
  worktreePath?: string
  mergeAborted?: boolean
  mergeStrategy?: 'squash' | 'no_ff'
  sourceWorkspaceId?: string
  targetWorkspaceId?: string
  sourceWorktreePath?: string
  targetWorktreePath?: string
  sessions: Session[]
  currentSessionId?: string
  teamRunId?: string
}

export function ResolveConflictsDialog({
  open,
  onOpenChange,
  workspaceId,
  conflictOp,
  conflictedFiles,
  sourceBranch,
  targetBranch,
  operation,
  worktreePath,
  mergeAborted,
  mergeStrategy,
  sourceWorkspaceId,
  targetWorkspaceId,
  sourceWorktreePath,
  targetWorktreePath,
  sessions,
  currentSessionId,
  teamRunId,
}: ResolveConflictsDialogProps) {
  const { t } = useI18n()
  const [selectedSessionId, setSelectedSessionId] = useState<string>('')
  const sendMessage = useSendMessage()
  const postRoomMessage = usePostRoomMessage(teamRunId ?? '')
  const openInEditor = useOpenInEditor()
  const isTeamRunMode = Boolean(teamRunId)
  const targetSessionId = currentSessionId || selectedSessionId
  const isSending = isTeamRunMode ? postRoomMessage.isPending : sendMessage.isPending

  const handleAiResolve = () => {
    const action = buildResolveConflictAiAction({
      workspaceId,
      worktreePath,
      operation,
      mergeAborted,
      mergeStrategy,
      sourceWorkspaceId,
      targetWorkspaceId,
      sourceWorktreePath,
      targetWorktreePath,
      sourceBranch,
      targetBranch,
      conflictedFiles,
      conflictOp,
      teamRunId,
      currentSessionId,
      selectedSessionId,
    })

    if (action.type === 'team_room') {
      postRoomMessage.mutate(
        { content: action.message, kind: 'chat' },
        {
          onSuccess: () => {
            toast.success(t('已发送到 Team Room'))
            onOpenChange(false)
          },
        },
      )
      return
    }

    if (action.type !== 'session') return
    sendMessage.mutate(
      { id: action.sessionId, message: action.message },
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
  const shouldShowSessionSelect = !isTeamRunMode && !currentSessionId && sessions.length > 0
  const canAiResolve = isTeamRunMode || Boolean(targetSessionId)

  return (
    <Modal
      isOpen={open}
      onClose={() => onOpenChange(false)}
      title={t('解决 {opLabel} 冲突', { opLabel })}
      action={
        <>
          <Button variant="secondary" onClick={handleManualResolve}>
            {t('在 IDE 中打开')}
          </Button>
          <Button
            variant="primary"
            onClick={handleAiResolve}
            disabled={!canAiResolve}
            loading={isSending}
          >
            {isSending ? t('发送中...') : t('AI 辅助解决')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* 冲突文件列表 */}
        <div>
          <h4 className="text-[13px] font-medium text-foreground mb-1.5">
            {t('冲突文件（{count}）', { count: conflictedFiles.length })}
          </h4>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-border/60 bg-foreground/[0.025]">
            {conflictedFiles.map((file) => (
              <div
                key={file}
                className="px-3 py-1.5 text-xs font-mono break-all text-foreground/85 border-b border-border/60 last:border-b-0"
              >
                {file}
              </div>
            ))}
          </div>
        </div>

        {isTeamRunMode && (
          <Notice tone="info">
            {t('TeamRun 模式下会把处理冲突请求发送到 Team Room，由团队调度处理。')}
          </Notice>
        )}

        {/* Session 选择 */}
        {shouldShowSessionSelect && (
          <Field label={t('选择 Session（AI 辅助解决）')}>
            <Select
              value={selectedSessionId}
              onValueChange={setSelectedSessionId}
              placeholder={t('选择一个 Session...')}
              options={sessions.map((s) => ({ value: s.id, label: `${s.agentType} — ${s.status}` }))}
            />
          </Field>
        )}

        {!isTeamRunMode && !targetSessionId && sessions.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t('没有可用的 Session，请在 IDE 中手动解决冲突。')}
          </p>
        )}
      </div>
    </Modal>
  )
}
