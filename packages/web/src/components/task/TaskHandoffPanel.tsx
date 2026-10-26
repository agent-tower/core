import { useEffect, useState } from 'react'
import { Streamdown } from 'streamdown'
import { TASK_HANDOFF_MAX_LENGTH } from '@agent-tower/shared'
import { Button, CopyButton, Notice, Textarea } from '@/design-system'
import { useTaskHandoff, useUpdateTaskHandoff } from '@/hooks/use-task-handoff'
import { ApiError } from '@/lib/api-client'
import { useI18n } from '@/lib/i18n'
import { streamdownComponents } from '@/lib/streamdown-components'

interface Draft { base: string; content: string }

function readDraft(key: string): Draft | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (value && typeof value === 'object' && 'base' in value && 'content' in value
      && typeof value.base === 'string' && typeof value.content === 'string') return { base: value.base, content: value.content }
  } catch { /* Storage may be unavailable. Editing still works in memory. */ }
  return null
}

/** The parent keys this panel by task ID; local drafts survive tab/panel switches. */
export function TaskHandoffPanel({ taskId, readOnly = false }: { taskId: string; readOnly?: boolean }) {
  const { t } = useI18n()
  const note = useTaskHandoff(taskId)
  const update = useUpdateTaskHandoff(taskId)
  const storageKey = `task-handoff-draft:${taskId}`
  const [draft, setDraft] = useState<Draft | null>(() => readDraft(storageKey))
  const editing = draft !== null && !readOnly

  useEffect(() => {
    try {
      if (draft) sessionStorage.setItem(storageKey, JSON.stringify(draft))
      else sessionStorage.removeItem(storageKey)
    } catch { /* Draft persistence is best effort. */ }
  }, [draft, storageKey])

  const save = async () => {
    if (!draft || update.isPending) return
    try {
      await update.mutateAsync({ oldString: draft.base, newString: draft.content })
      // A save may finish after the panel was closed. Clear only that submitted draft.
      try {
        const stored = readDraft(storageKey)
        if (stored?.base === draft.base && stored.content === draft.content) sessionStorage.removeItem(storageKey)
      } catch { /* Storage is optional. */ }
      setDraft(null)
    } catch { /* Keep the draft and render the mutation error. */ }
  }

  if (note.isPending) return <p className="p-4 text-sm text-muted-foreground">{t('Loading...')}</p>
  if (!note.data) return (
    <div className="p-3"><Notice tone="danger" action={<Button variant="link" size="sm" onClick={() => note.refetch()}>{t('Retry')}</Button>}>
      {t('Could not load the handoff note.')}
    </Notice></div>
  )

  const changed = editing && draft.base !== note.data.content
  const errorCode = update.error instanceof ApiError ? update.error.details.code : undefined
  const conflict = typeof errorCode === 'string' && ['HANDOFF_CHANGED', 'HANDOFF_NOT_EMPTY', 'HANDOFF_TEXT_NOT_FOUND', 'HANDOFF_TEXT_AMBIGUOUS'].includes(errorCode)

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t('Handoff note')}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <span className="text-xs text-muted-foreground">{editing ? t('Markdown') : t('Progress, decisions, and next steps')}</span>
        <div className="flex items-center gap-1">
          <CopyButton value={editing ? draft.content : note.data.content} display="text" size="sm" />
          {editing ? <>
            <Button variant="ghost" size="sm" disabled={update.isPending} onClick={() => { setDraft(null); update.reset() }}>{t('Cancel')}</Button>
            <Button size="sm" disabled={update.isPending || draft.content === draft.base} onClick={save}>{update.isPending ? t('保存中...') : t('Save')}</Button>
          </> : !readOnly && (
            <Button variant="secondary" size="sm" onClick={() => { update.reset(); setDraft({ base: note.data.content, content: note.data.content }) }}>{t('编辑')}</Button>
          )}
        </div>
      </div>
      {editing && (changed || conflict) && <Notice tone="warning" size="sm" className="mx-3 mt-3" role="status">
        {t('The handoff changed elsewhere. Your draft is preserved. Cancel editing to view the latest note.')}
      </Notice>}
      {editing && update.isError && !conflict && <Notice tone="danger" size="sm" className="mx-3 mt-3" role="alert">
        {t('Could not save the handoff note. Your draft is preserved.')}
      </Notice>}
      {editing ? (
        <div className="flex min-h-0 flex-1 p-3">
          <Textarea
            aria-label={t('Handoff Markdown')}
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
            maxLength={TASK_HANDOFF_MAX_LENGTH}
            disabled={update.isPending}
            className="min-h-0 flex-1 font-mono"
            placeholder={t('Summarize progress, decisions, verification, open problems, and next steps.')}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void save() } }}
          />
        </div>
      ) : (
        <div className="prose prose-sm max-w-none min-h-0 flex-1 overflow-y-auto p-4 dark:prose-invert [overflow-wrap:anywhere]">
          {note.data.content ? <Streamdown components={streamdownComponents}>{note.data.content}</Streamdown> : (
            <p className="py-6 text-center text-muted-foreground">{t('No handoff note yet. Record what has been done and what comes next.')}</p>
          )}
        </div>
      )}
    </section>
  )
}
