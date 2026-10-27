import { canCreateSubtask } from '@agent-tower/shared'
import { ListTree, Plus } from 'lucide-react'
import { Button } from '@/design-system'
import { useSubtasks, useTask } from '@/hooks/use-tasks'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { mapTaskStatusToUI } from './adapters'
import { STATUS_STYLES } from './status-styles'
import type { UITaskDetailData } from './types'

export function SubtaskPanel({ task, onSelectTask, onCreateSubtask }: {
  task: UITaskDetailData
  onSelectTask?: (id: string) => void
  onCreateSubtask?: (id: string) => void
}) {
  const { t } = useI18n()
  const parent = useTask(task.parentTaskId ?? '')
  const children = useSubtasks(task.id, canCreateSubtask(task))
  const count = children.data?.pages[0]?.total ?? task.subtaskCount ?? 0


  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t('Subtasks')}>
      {task.parentTaskId && (
        <div className="shrink-0 border-b border-border/60 px-3 py-2">
          <Button variant="link" size="sm" className="max-w-full" onClick={() => onSelectTask?.(task.parentTaskId!)}>
            <ListTree size={14} className="shrink-0" />
            <span className="truncate">{t('Parent task: {title}', { title: parent.data?.titlePreview ?? parent.data?.title ?? t('Loading...') })}</span>
          </Button>
        </div>
      )}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <span className="text-xs tabular-nums text-muted-foreground">{t('{count} subtasks', { count })}</span>
        {onCreateSubtask && canCreateSubtask(task) && !task.projectArchivedAt && (
          <Button variant="ghost" size="sm" onClick={() => onCreateSubtask(task.id)}>
            <Plus size={14} />{t('Create subtask')}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {!canCreateSubtask(task) && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t('Tasks support at most three levels')}</p>}
        {children.isLoading && <p className="px-2 py-1 text-xs text-muted-foreground">{t('Loading...')}</p>}
        {children.isError && <Button variant="ghost" size="sm" onClick={() => children.refetch()}>{t('Could not load subtasks. Retry')}</Button>}
        {children.data?.pages.flatMap(page => page.data).map(child => {
          const style = STATUS_STYLES[mapTaskStatusToUI(child.status)]
          return (
            <Button key={child.id} variant="ghost" size="sm" className="w-full justify-start" title={child.title} onClick={() => onSelectTask?.(child.id)}>
              <style.icon className={cn('size-3.5 shrink-0', style.accentClass)} />
              <span className="min-w-0 flex-1 truncate text-left">{child.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{t(style.label)}</span>
            </Button>
          )
        })}
        {children.data && count === 0 && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t('No subtasks yet')}</p>}
        {children.hasNextPage && <Button variant="ghost" size="sm" disabled={children.isFetchingNextPage} onClick={() => children.fetchNextPage()}>{t('Load more')}</Button>}
      </div>
    </section>
  )
}
