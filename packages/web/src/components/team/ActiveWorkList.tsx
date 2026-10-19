import { useMemo, useState } from 'react'
import { Ban, ChevronDown, ChevronUp, PanelRightOpen, Square } from 'lucide-react'
import type { AgentInvocation, TeamMember, WorkRequest } from '@agent-tower/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { MemberAvatar } from './MemberAvatar'
import { ACTIVE_ROOM_INVOCATION_STATUSES } from './room-timeline-items'

type ActiveWorkListProps = {
  invocations: AgentInvocation[]
  memberById: Map<string, TeamMember>
  workRequestById: Map<string, WorkRequest>
  onViewInvocationSession?: (sessionId: string) => void
  onStopMember: (memberId: string, cancelQueued: boolean) => void
  isStopPending: boolean
  stoppingMemberId?: string | null
  stopPromptInvocationId: string | null
  onToggleStopConfirm: (invocationId: string) => void
}

function formatActiveStatus(status: AgentInvocation['status']) {
  switch (status) {
    case 'RUNNING':
      return 'Working'
    case 'QUEUED':
      return 'Queued...'
    case 'WAITING_ROOM_REPLY':
      return 'Waiting reply...'
    case 'SESSION_ENDED':
      return 'Session ended'
    default:
      return status
  }
}

function statusTextClass(status: AgentInvocation['status']) {
  switch (status) {
    case 'FAILED':
      return 'text-destructive-ink'
    case 'RUNNING':
    case 'WAITING_ROOM_REPLY':
    case 'QUEUED':
    case 'SESSION_ENDED':
      return 'text-muted-foreground'
    default:
      return 'text-muted-foreground'
  }
}

function summarizeActiveWork(invocations: AgentInvocation[], t: (key: string) => string) {
  const counts = invocations.reduce<Record<string, number>>((summary, invocation) => {
    summary[invocation.status] = (summary[invocation.status] ?? 0) + 1
    return summary
  }, {})

  const parts = [
    ['RUNNING', 'running'],
    ['QUEUED', 'queued'],
    ['WAITING_ROOM_REPLY', 'waiting'],
    ['SESSION_ENDED', 'ended'],
  ]
    .map(([status, label]) => {
      const count = counts[status]
      return count ? `${count} ${t(label)}` : null
    })
    .filter((part): part is string => Boolean(part))

  return parts.join(' · ')
}

function defaultIsOpen() {
  if (typeof window === 'undefined') return false
  if (typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(min-width: 768px)').matches
}

function ActiveStatusText({ status }: { status: AgentInvocation['status'] }) {
  const { t } = useI18n()

  if (status === 'RUNNING') {
    return (
      <>
        {t('Working')}
        <span className="active-work-dots" aria-hidden="true">
          <span>.</span>
          <span className="active-work-dots__second">.</span>
          <span className="active-work-dots__third">.</span>
        </span>
      </>
    )
  }

  return <>{t(formatActiveStatus(status))}</>
}

export function ActiveWorkList({
  invocations,
  memberById,
  workRequestById,
  onViewInvocationSession,
  onStopMember,
  isStopPending,
  stoppingMemberId,
  stopPromptInvocationId,
  onToggleStopConfirm,
}: ActiveWorkListProps) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(defaultIsOpen)

  const activeInvocations = useMemo(
    () =>
      invocations
        .filter((invocation) => ACTIVE_ROOM_INVOCATION_STATUSES.has(invocation.status))
        .sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? '') - Date.parse(a.updatedAt ?? a.createdAt ?? '')),
    [invocations],
  )

  if (activeInvocations.length === 0) {
    return null
  }

  const summary = summarizeActiveWork(activeInvocations, t)

  return (
    <div className="border-t border-border bg-muted/40">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
        className="flex h-8 w-full items-center justify-between gap-3 px-3 text-left text-xs text-foreground/70 transition-colors hover:bg-accent"
      >
        <span className="min-w-0 truncate">
          <span className="font-medium text-foreground">{t('Active work')}</span>
          <span className="mx-1.5 text-muted-foreground">·</span>
          <span>{summary}</span>
        </span>
        {isOpen ? <ChevronDown size={15} className="shrink-0 text-muted-foreground/70" /> : <ChevronUp size={15} className="shrink-0 text-muted-foreground/70" />}
      </button>

      {isOpen && (
        <div className="max-h-32 overflow-y-auto border-t border-border">
          {activeInvocations.map((invocation) => {
            const member = memberById.get(invocation.memberId)
            const workRequest = workRequestById.get(invocation.workRequestId)
            const canOpenSession = Boolean(invocation.sessionId && onViewInvocationSession)
            const canStop = Boolean(member)
            const isConfirmingStop = stopPromptInvocationId === invocation.id
            const isStoppingMember = isStopPending && stoppingMemberId === invocation.memberId
            const instruction = workRequest?.instruction ?? invocation.workRequestId

            return (
              <div key={invocation.id} className="border-t border-border/60 first:border-t-0">
                <div
                  title={instruction}
                  className={cn(
                    'group flex h-8 items-center gap-2 px-3 text-xs text-foreground/80',
                    canOpenSession ? 'cursor-pointer hover:bg-background' : 'cursor-default',
                  )}
                  role={canOpenSession ? 'button' : undefined}
                  tabIndex={canOpenSession ? 0 : undefined}
                  onClick={() => invocation.sessionId && onViewInvocationSession?.(invocation.sessionId)}
                  onKeyDown={(event) => {
                    if (!canOpenSession || !invocation.sessionId) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onViewInvocationSession?.(invocation.sessionId)
                    }
                  }}
                >
                  <MemberAvatar
                    name={member?.name ?? t('Agent')}
                    avatar={member?.avatar ?? null}
                    size="xs"
                    className="size-4"
                  />
                  <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span className="truncate font-medium text-foreground">{member?.name ?? t('Agent')}</span>
                    <span className={cn('shrink-0', statusTextClass(invocation.status))}>
                      <ActiveStatusText status={invocation.status} />
                    </span>
                  </div>
                  {canOpenSession && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        invocation.sessionId && onViewInvocationSession?.(invocation.sessionId)
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                      className="hidden shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground/80 group-hover:inline-flex"
                      title={t('View log')}
                      aria-label={`${t('View log')} ${member?.name ?? t('Agent')}`}
                    >
                      <PanelRightOpen size={13} />
                    </button>
                  )}
                  {canStop && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onToggleStopConfirm(invocation.id)
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                      disabled={isStoppingMember}
                      className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive-ink disabled:cursor-not-allowed disabled:opacity-50"
                      title={t('Stop')}
                      aria-label={`${t('Stop')} ${member?.name ?? t('Agent')}`}
                    >
                      <Square size={12} />
                    </button>
                  )}
                </div>

                {canStop && isConfirmingStop && member && (
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 bg-background px-3 py-2">
                    <span className="mr-1 text-xs text-foreground/70">{t('Stop running work?')}</span>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={isStoppingMember}
                      onClick={() => onStopMember(member.id, false)}
                    >
                      <Square size={11} />
                      <span>{isStoppingMember ? t('Stopping') : t('Stop only')}</span>
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={isStoppingMember}
                      className="border-destructive/25 bg-destructive/10 text-destructive-ink hover:bg-destructive/15 hover:text-destructive-ink"
                      onClick={() => onStopMember(member.id, true)}
                    >
                      <Ban size={11} />
                      <span>{isStoppingMember ? t('Stopping') : t('Stop + clear queue')}</span>
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
