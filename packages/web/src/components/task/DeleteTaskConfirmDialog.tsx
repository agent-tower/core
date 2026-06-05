import { useMemo } from 'react'
import { SessionStatus, type Workspace } from '@agent-tower/shared'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { useI18n } from '@/lib/i18n'

type TranslateFn = (source: string, values?: Record<string, string | number | boolean | null | undefined>) => string

export function buildDeleteTaskWarnings(workspaces: Workspace[] | undefined, t: TranslateFn): string[] {
  const warnings: string[] = []
  if (!workspaces || workspaces.length === 0) return warnings

  const hasActive = workspaces.some(ws => ws.status === 'ACTIVE')
  const hasRunning = workspaces.some(ws =>
    ws.sessions?.some(s => s.status === SessionStatus.RUNNING || s.status === SessionStatus.PENDING)
  )

  if (hasRunning) warnings.push(t('正在运行的 Agent 将被停止'))
  if (hasActive) {
    warnings.push(t('分支上未合并的变更将丢失'))
    warnings.push(t('关联的工作目录（worktree）将被清理'))
  }

  return warnings
}

export interface DeleteTaskConfirmDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  taskId: string
  taskTitle: string
  /** Pre-fetched workspaces — when provided, skips internal fetch (avoids duplicate queries) */
  workspaces?: Workspace[]
  isLoading?: boolean
}

export function DeleteTaskConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  taskId,
  taskTitle,
  workspaces: externalWorkspaces,
  isLoading,
}: DeleteTaskConfirmDialogProps) {
  const { t } = useI18n()

  const { data: fetchedWorkspaces, isLoading: isLoadingWorkspaces } = useWorkspaces(
    externalWorkspaces === undefined && isOpen ? taskId : ''
  )

  const workspaces = externalWorkspaces ?? fetchedWorkspaces
  const warningsLoading = externalWorkspaces === undefined && isOpen && isLoadingWorkspaces

  const warnings = useMemo(
    () => buildDeleteTaskWarnings(workspaces, t),
    [workspaces, t]
  )

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      title={t('删除任务')}
      description={
        <>
          <p>{t('确认删除任务「{title}」？此操作不可撤销。', { title: taskTitle })}</p>
          {warningsLoading ? (
            <p className="mt-2 text-xs text-neutral-400">{t('加载中...')}</p>
          ) : warnings.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-1.5 text-amber-600">
                  <span className="mt-1 shrink-0 w-1.5 h-1.5 rounded-full bg-amber-400" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      }
      confirmText={t('删除')}
      variant="danger"
      isLoading={isLoading || warningsLoading}
    />
  )
}
