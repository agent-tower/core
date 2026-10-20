import { useAttachmentMetadata } from '@/hooks/use-attachments'
import { useI18n } from '@/lib/i18n'
import { useRetryOutgoing, type OutgoingSubmission } from '@/hooks/outgoing-submissions'
export function OutgoingSubmissionBubble({ item, onConversationCreated }: { item: OutgoingSubmission; onConversationCreated?: (id: string) => void }) {
  const { t } = useI18n()
  const ids = 'attachmentIds' in item.body && Array.isArray(item.body.attachmentIds) ? item.body.attachmentIds as string[] : []
  const attachments = useAttachmentMetadata(ids)
  const retry = useRetryOutgoing(item)
  return <div className="my-4 flex justify-end" data-submission-id={item.id}>
    <div className="flex max-w-[85%] min-w-0 flex-col items-end">
      <div className="max-w-full min-w-0 rounded-2xl rounded-tr-sm bg-foreground/[0.08] px-5 py-3.5 text-sm">
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
        {attachments.data?.map(file => <span key={file.id} className="mt-1 block text-xs text-muted-foreground">{file.originalName}</span>)}
      </div>
      {item.failed && <div className="mt-1 max-w-full px-0.5 text-xs text-muted-foreground" data-message-feedback>
        <p>{t('Acceptance unknown; check or retry the same submission.')}</p>
        <button type="button" className="mt-1 text-xs underline" disabled={retry.isPending} onClick={() => retry.mutate(undefined, { onSuccess: result => { if ('id' in result) onConversationCreated?.(result.id) } })}>{t('Retry original submission')}</button>
      </div>}
    </div>
  </div>
}
