import { useMemo } from 'react'
import { SessionStatus, type Workspace } from '@agent-tower/shared'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { useSubtasks } from '@/hooks/use-tasks'
import { Button } from '@/design-system'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { useI18n } from '@/lib/i18n'

type TranslateFn = (source: string, values?: Record<string, string | number | boolean | null | undefined>) => string

function buildDeleteTaskWarnings(workspaces: Workspace[] | undefined, t: TranslateFn): string[] {
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
  onConfirm: (subtaskCount: number) => void
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

  const children = useSubtasks(taskId, isOpen)
  const subtaskCount = children.data?.pages[0]?.total ?? 0
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
      onConfirm={() => onConfirm(subtaskCount)}
      title={t('删除任务')}
      description={
        <>
          <p>{subtaskCount > 0
            ? t('Delete “{title}” and its {count} subtasks? This cannot be undone.', { title: taskTitle, count: subtaskCount })
            : t('确认删除任务「{title}」？此操作不可撤销。', { title: taskTitle })}</p>
          {subtaskCount > 0 && <p className="mt-2 text-warning-ink">{t('All related Agents and services will stop. Their worktrees and owned branches will be deleted.')}</p>}
          {children.isError && <Button variant="ghost" size="sm" onClick={() => children.refetch()}>{t('Could not load subtasks. Retry')}</Button>}
          {children.isFetching && <p className="mt-2 text-xs text-muted-foreground">{t('Loading...')}</p>}
          {warningsLoading ? (
            <p className="mt-2 text-xs text-muted-foreground">{t('加载中...')}</p>
          ) : warnings.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-1.5 text-warning-ink">
                  <span className="mt-1 shrink-0 w-1.5 h-1.5 rounded-full bg-warning" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      }
      confirmText={subtaskCount > 0 ? t('Delete all') : t('删除')}
      variant="danger"
      isLoading={isLoading}
      confirmDisabled={warningsLoading || children.isFetching || children.isError || !children.data}
    />
  )
}
