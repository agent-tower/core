import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { pendingTeamInitialSubmission } from '@/hooks/team-initial-submission'
import { useCreateTaskTeamRun } from '@/hooks/use-team-run'
import { useI18n } from '@/lib/i18n'
import { TeamRoomDeliveryStatus } from './TeamRoomDeliveryStatus'

/** Restores a Task-scoped operation without importing old configuration into a new draft. */
export function TeamInitialDeliveryStatus({ taskId }: { taskId: string }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const create = useCreateTaskTeamRun()
  const [actionError, setError] = useState<string | null>(null)
  let unknown = false
  let storageError: string | null = null
  try { unknown = !!pendingTeamInitialSubmission(taskId) } catch (e) { storageError = (e as Error).message }
  const error = storageError ?? actionError
  const recover = async () => {
    try {
      const saved = pendingTeamInitialSubmission(taskId)
      if (saved) await create.mutateAsync({ taskId, ...saved })
      setError(null)
      void client.invalidateQueries({ queryKey: ['message-deliveries', `task:${taskId}`] })
    } catch (e) { setError((e as Error).message) }
  }
  return <div className="space-y-2 py-2" data-team-creation-status>
    {unknown && <div className="rounded border p-2 text-xs">
      <p>{t('Team creation result unknown. Check the original request.')}</p>
      <button type="button" className="underline" disabled={create.isPending} onClick={() => void recover()}>{t('Check team creation')}</button>
    </div>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <TeamRoomDeliveryStatus taskId={taskId} teamRunId="" />
  </div>
}
