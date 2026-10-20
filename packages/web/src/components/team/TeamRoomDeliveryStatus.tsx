import { MessageDeliveryAttachments, MessageDeliveryFeedback } from '@/components/agent/MessageDeliveryStatus'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { TeamTaskInputSummary, TeamTaskInputDetail } from '@agent-tower/shared'
import { useMessageDeliveries } from '@/hooks/use-message-deliveries'
import { apiClient } from '@/lib/api-client'
import { useI18n } from '@/lib/i18n'
import { userSubmission } from '@/hooks/user-submission'
import { useTranslationSettings } from '@/hooks/use-translation-settings'

export function TeamRoomDeliveryStatus({ taskId, teamRunId, enabled = true, showDeliveries = true }: { taskId: string; teamRunId: string; enabled?: boolean; showDeliveries?: boolean }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const settings = useTranslationSettings()
  const deliveries = useMessageDeliveries(enabled ? `task:${taskId}` : '', 'pending', 'TEAM_TASK')
  const inputs = useInfiniteQuery({ queryKey: ['team-task-inputs', teamRunId], initialPageParam: undefined as string | undefined, queryFn: ({ pageParam }) => apiClient.get<{ items: TeamTaskInputSummary[]; nextCursor: string | null }>(`/team-runs/${teamRunId}/task-inputs${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`), getNextPageParam: page => page.nextCursor ?? undefined, enabled: enabled && !!teamRunId, refetchInterval: 2000 })
  const inputAction = useMutation({
    mutationFn: ({ input, action }: { input: TeamTaskInputSummary; action: 'retry_translation' | 'send_original' }) => userSubmission(`task-input:${input.id}`, { action, expectedRevision: input.revision }, body => {
      const { clientSubmissionId, ...rest } = body
      return apiClient.post(`/team-runs/${teamRunId}/task-inputs/${input.id}/actions`, { ...rest, actionId: clientSubmissionId })
    }),
    onSettled: () => { void client.invalidateQueries({ queryKey: ['team-task-inputs', teamRunId] }); void client.invalidateQueries({ queryKey: ['message-deliveries', `task:${taskId}`] }) },
  })
  const fullInput = useMutation({ mutationFn: (id: string) => apiClient.get<TeamTaskInputDetail>(`/team-runs/${teamRunId}/task-inputs/${id}`) })
  if (!enabled) return null
  return <div className="space-y-2 text-xs" aria-live="polite">
    {showDeliveries && deliveries.data?.pages.flatMap(page => page.items).filter(item => !['SENT', 'CANCELLED'].includes(item.state)).map(item => <div key={item.id} className="flex justify-end" data-operation-id={item.id}>
      <div className="flex max-w-[85%] min-w-0 flex-col items-end">
        {item.origin === 'TEAM_INITIAL' && <p className="mb-1 px-0.5 text-xs text-muted-foreground">{t('Team creation pending')}</p>}
        <div className="max-w-full rounded-2xl rounded-tr-sm bg-foreground/[0.08] px-5 py-3.5 text-sm">
          <p className="whitespace-pre-wrap break-words">{item.originalText}</p>
          <MessageDeliveryAttachments delivery={item} />
        </div>
        <div className="mt-1 max-w-full px-0.5" data-message-feedback><MessageDeliveryFeedback delivery={item} /></div>
      </div>
    </div>)}
    {inputs.data?.pages.flatMap(page => page.items).filter(input => input.state === 'PENDING' && input.consumerCount > 0).map(input => <div className="ml-auto max-w-[85%] space-y-1 px-0.5 text-muted-foreground" key={input.id}>
      <p>{t('Task input')}: {input.translationState ?? 'PENDING'} {input.errorCode ?? ''}</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="underline" disabled={fullInput.isPending} onClick={() => fullInput.mutate(input.id)}>{t('查看原文')}</button>
        <button type="button" className="underline" disabled={inputAction.isPending} onClick={() => inputAction.mutate({ input, action: 'send_original' })}>{t('Send original')}</button>
        {settings.data?.enabled === true && ['FAILED', 'CANCELLED', 'QUEUE_FULL', 'PAUSED_DISABLED', 'INTERRUPTED'].includes(input.translationState ?? '') && <button type="button" className="underline" disabled={inputAction.isPending} onClick={() => inputAction.mutate({ input, action: 'retry_translation' })}>{t('Retry translation')}</button>}
      </div>
      {fullInput.data?.id === input.id && <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{fullInput.data.originalText}</pre>}
    </div>)}
    {inputs.hasNextPage && <button type="button" className="underline" onClick={() => void inputs.fetchNextPage()}>{t('Load more task inputs')}</button>}
    {deliveries.hasNextPage && <button type="button" className="underline" onClick={() => void deliveries.fetchNextPage()}>{t('Load more')}</button>}
    {(inputAction.error || fullInput.error) && <p role="alert">{t('Delivery action failed. Refresh and try again.')}</p>}
    {(deliveries.error || inputs.error) && <p role="alert">{t('Failed to restore pending messages')}</p>}
  </div>
}
