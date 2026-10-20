import { useAttachmentMetadata } from '@/hooks/use-attachments'
import { isSessionMessageDelivery, type MessageDelivery, type MessageDeliveryAction } from '@agent-tower/shared'
import { useDeliveryAction } from '@/hooks/use-message-deliveries'
import { useI18n } from '@/lib/i18n'
import { useTranslationSettings } from '@/hooks/use-translation-settings'
import { TranslationComparison } from './TranslationComparison'

/** Attachment content stays in the bubble; operation feedback belongs below it. */
export function MessageDeliveryAttachments({ delivery: item }: { delivery: MessageDelivery }) {
  const attachments = useAttachmentMetadata(item.attachmentIds)
  if (['SENT', 'CANCELLED'].includes(item.state)) return null
  return attachments.data?.map(file => <a key={file.id} className="mt-1 block text-xs underline" href={`/api/attachments/${encodeURIComponent(file.id)}/file`} target="_blank" rel="noreferrer">{file.originalName}</a>)
}

/** One operation, rendered below its user message bubble. */
export function MessageDeliveryFeedback({ delivery: item }: { delivery: MessageDelivery }) {
  const { t } = useI18n()
  const action = useDeliveryAction(isSessionMessageDelivery(item) ? item.sessionId : `task:${item.destination.taskId}`)
  const settings = useTranslationSettings()
  // A mode alone is insufficient: unresolved translations can carry a default mode.
  // Only frozen accepted content proves that this operation is sending the original.
  const originalAccepted = item.sentMode === 'ORIGINAL' && item.acceptedText !== null
  // Submission feedback belongs on the send button. Durable queues and failures
  // still need their own feedback and recovery, including after a reload.
  if (originalAccepted && !item.lastError && ['READY', 'DISPATCHING'].includes(item.state)) return null
  // The receipt records whether this message was translated, independent of current settings.
  if (item.state === 'SENT' && item.sentMode !== 'TRANSLATED') return null
  if (item.state === 'SENT') return <div className="flex justify-end">
    <TranslationComparison original={item.actualSentText ?? ''} label="Actual sent text">
      <pre className="whitespace-pre-wrap">{item.actualSentText}</pre>
    </TranslationComparison>
  </div>
  if (item.state === 'CANCELLED') return <p className="mt-1 text-xs text-muted-foreground">{t('Cancelled')}</p>
  const options: Array<[MessageDeliveryAction, string]> = item.state === 'DELIVERY_UNKNOWN'
    ? [['confirm_not_sent', 'Confirmed not sent: retry'], ['end_unknown', 'End operation (may already be received)']]
    : item.state === 'DISPATCHING' ? [] : [
      ...(!originalAccepted && settings.data?.enabled === true && ['TRANSLATION_FAILED', 'PAUSED_DISABLED'].includes(item.state) ? [['retry_translation', 'Retry translation'] as [MessageDeliveryAction, string]] : []),
      ...(['DELIVERY_FAILED', 'PAUSED_DISABLED'].includes(item.state) && item.acceptedText !== null ? [['retry_delivery', 'Retry delivery'] as [MessageDeliveryAction, string]] : []),
      ...(!originalAccepted && ['TRANSLATION_FAILED', 'PAUSED_DISABLED', 'WAITING_TRANSLATION', 'WAITING_TASK_INPUT', 'READY', 'WAITING_PREDECESSOR', 'ACCEPTED'].includes(item.state) ? [['send_original', 'Send original'] as [MessageDeliveryAction, string]] : []),
      ['cancel', 'Cancel'] as [MessageDeliveryAction, string],
    ]
  return <div className="space-y-1 text-xs text-muted-foreground" data-delivery-state={item.state} aria-live="polite">
    <p>{t(item.state === 'DELIVERY_UNKNOWN' ? 'Delivery result unknown. Verify before retrying.' : ['ACCEPTED', 'WAITING_PREDECESSOR'].includes(item.state) ? 'Queued, not sent' : item.state === 'TRANSLATION_FAILED' ? 'Translation failed' : item.state === 'PAUSED_DISABLED' ? 'Sending paused' : item.state === 'DELIVERY_FAILED' ? 'Delivery failed' : item.state === 'WAITING_TASK_INPUT' ? 'Waiting for task input' : item.state === 'WAITING_TRANSLATION' ? 'Waiting for translation' : 'Waiting to send')}</p>
    {item.lastError && <p>{item.lastError}</p>}
    <div className="flex flex-wrap gap-x-3 gap-y-1">{options.map(([name, label]) => <button type="button" key={name} className="underline" disabled={action.isPending} onClick={() => action.mutate({ delivery: item, action: name })}>{t(label)}</button>)}</div>
    {action.error && <p role="alert" className="text-destructive">{t('Delivery action failed. Refresh and try again.')}</p>}
  </div>
}
