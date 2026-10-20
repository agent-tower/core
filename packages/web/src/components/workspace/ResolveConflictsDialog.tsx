import { useEffect, useRef, useState } from 'react'
import type { ConflictOp, GitOperationStatus, RefreshConflictContextResponse, Session } from '@agent-tower/shared'
import { apiClient } from '@/lib/api-client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { Button, Field, Notice, Select } from '@/design-system'
import { buildResolveConflictAiAction } from '@/lib/conflict-instructions'
import { useSendMessage } from '@/hooks/use-sessions'
import { usePostRoomMessage } from '@/hooks/use-team-run'
import { useOpenInEditor } from '@/hooks/use-workspaces'
import { useI18n } from '@/lib/i18n'
import { conflictRecoveryStorageUnavailable, conflictTokenHint, readConflictRecovery, removeConflictRecovery, saveConflictRecovery } from '@/lib/conflict-recovery-storage'
import { pendingConflictReceiver, submissionStorageUnavailable } from '@/hooks/user-submission'

interface ResolveConflictsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  resolutionContextToken?: string
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
  resolutionContextToken,
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
  const [contextOverride, setContextOverride] = useState<{ original?: string; workspaceId: string; token: string }>()
  const [recoveryError, setRecoveryError] = useState('')
  const [isChecking, setIsChecking] = useState(false)
  const [selectedSessionId, setSelectedSessionId] = useState<string>('')
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const sendMessage = useSendMessage()
  const postRoomMessage = usePostRoomMessage(teamRunId ?? '')
  const openInEditor = useOpenInEditor()
  const isTeamRunMode = Boolean(teamRunId)
  const hint = conflictTokenHint(resolutionContextToken)
  const saved = hint ? readConflictRecovery(hint.actor).find(draft => draft.operationId === hint.operationId) : undefined
  const frozenReceiver = pendingConflictReceiver(resolutionContextToken)
  const targetSessionId = frozenReceiver || saved?.receiverSessionId || currentSessionId || selectedSessionId
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
      currentSessionId: targetSessionId,
      selectedSessionId,
    })

    if (action.type === 'team_room') {
      postRoomMessage.mutate(
        { content: action.message, kind: 'chat' },
        {
          onSuccess: () => {
            toast.success(t('已受理，等待发送到 Team Room'))
            onOpenChange(false)
          },
        },
      )
      return
    }

    if (action.type !== 'session') return
    const token = contextOverride && contextOverride.workspaceId === workspaceId && contextOverride.original === resolutionContextToken ? contextOverride.token : resolutionContextToken
    saveConflictRecovery({ conflictOp, conflictedFiles, sourceBranch, targetBranch, mergeAborted, mergeStrategy,
      sourceWorkspaceId: sourceWorkspaceId ?? workspaceId, targetWorkspaceId, sourceWorktreePath, targetWorktreePath, resolutionContextToken: token }, action.sessionId)
    sendMessage.mutate(
      { id: action.sessionId, message: action.message, systemAction: 'resolve_conflicts', resolutionContextToken: token },
      { onSuccess: () => { if (active.current) { removeConflictRecovery(token); onOpenChange(false) } }, onError: (error) => { if (active.current) setRecoveryError(error instanceof Error ? error.message : String(error)) } }
    )
  }

  const handleManualResolve = () => {
    openInEditor.mutate(
      { workspaceId },
      { onSuccess: () => onOpenChange(false) }
    )
  }

  const opLabel = conflictOp === 'REBASE' ? 'Rebase' : 'Merge'
  const shouldShowSessionSelect = !isTeamRunMode && !currentSessionId && !frozenReceiver && !saved?.receiverSessionId && sessions.length > 0
  const canAiResolve = isTeamRunMode || Boolean(targetSessionId)

  return (
    <Modal
      isOpen={open}
      onClose={() => onOpenChange(false)}
      title={t('解决 {opLabel} 冲突', { opLabel })}
      action={
        <>
          <Button variant="secondary" onClick={handleManualResolve} disabled={Boolean(targetWorktreePath && !targetWorkspaceId && sourceWorktreePath !== targetWorktreePath)}>
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
        {!isTeamRunMode && (
          <div className="space-y-2 text-sm">
            {recoveryError && <p role="alert" className="text-red-700">{recoveryError}</p>}
            <p>{t('重新核验仅读取 Git，不自动发送。现场变化（包括部分 stage）可能无法继续 AI 恢复；请保留成果，在实际目标手工继续，或确认后明确中止并重做原操作。')}</p>
            <p>{t('实际冲突目标目录')}：<code>{targetWorktreePath ?? worktreePath}</code></p>
            {(conflictRecoveryStorageUnavailable() || submissionStorageUnavailable()) && <p role="alert">{t('浏览器存储不可用或资料损坏；本页仅在内存中保留，刷新后可能无法恢复。请先保存操作资料。')}</p>}
            {saved?.expiresAt && <p>{t('恢复截止时间')}：{new Date(saved.expiresAt).toLocaleString()}</p>}
            {frozenReceiver && <p>{t('结果未知或待重试的原提交将先使用原 Session、UUID 和原请求核对；明确未受理后才使用新凭据。')}</p>}
            <Button variant="secondary" disabled={isChecking || isSending} onClick={async () => {
              setIsChecking(true)
              try {
                const sourceId = sourceWorkspaceId ?? workspaceId
                const status = resolutionContextToken
                  ? await apiClient.post<RefreshConflictContextResponse>(`/workspaces/${sourceId}/conflict-context`, { resolutionContextToken })
                  : await apiClient.get<GitOperationStatus>(`/workspaces/${sourceId}/git-status`)
                if (!active.current) return
                if (!status.resolutionContextToken) throw new Error(t('没有可核验的当前冲突。请求尚未受理；请保留原操作资料，确认 Git 状态后明确重新执行原操作。刷新或重试发送不会执行 Git。'))
                setContextOverride({ original: resolutionContextToken, workspaceId, token: status.resolutionContextToken })
                saveConflictRecovery({ conflictOp, conflictedFiles, sourceBranch, targetBranch, mergeAborted, mergeStrategy,
                  sourceWorkspaceId: sourceId, targetWorkspaceId, sourceWorktreePath, targetWorktreePath, resolutionContextToken: status.resolutionContextToken }, targetSessionId)
                setRecoveryError('')
              } catch (error) { if (active.current) setRecoveryError(error instanceof Error ? error.message : String(error)) }
              finally { if (active.current) setIsChecking(false) }
            }}>{t('只读核验当前冲突')}</Button>
          </div>
        )}
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
