import { useMemo } from 'react'
import { Bot, Clock3, Layers3, MessageSquare, RefreshCw, Users } from 'lucide-react'
import type { AgentInvocation, TeamMember, TeamRun, WorkRequest } from '@agent-tower/shared'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

interface TeamStatusPanelProps {
  teamRun: TeamRun
}

const EMPTY_MEMBERS: TeamMember[] = []
const EMPTY_WORK_REQUESTS: WorkRequest[] = []
const EMPTY_INVOCATIONS: AgentInvocation[] = []

type MemberStatus = 'running' | 'waiting room reply' | 'queued' | 'pending approval' | 'idle'

function formatTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function statusLabel(status: MemberStatus) {
  switch (status) {
    case 'running':
      return 'Running'
    case 'waiting room reply':
      return 'Waiting room reply'
    case 'queued':
      return 'Queued'
    case 'pending approval':
      return 'Pending approval'
    case 'idle':
      return 'Idle'
  }
}

function statusClass(status: MemberStatus) {
  switch (status) {
    case 'running':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700'
    case 'waiting room reply':
      return 'border-amber-200 bg-amber-50 text-amber-700'
    case 'queued':
      return 'border-blue-200 bg-blue-50 text-blue-700'
    case 'pending approval':
      return 'border-neutral-200 bg-neutral-50 text-neutral-600'
    case 'idle':
      return 'border-neutral-200 bg-white text-neutral-500'
  }
}

function getInitials(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
  }
  return Array.from(trimmed).slice(0, 2).join('').toUpperCase()
}

function Avatar({ name, avatar }: { name: string; avatar?: string | null }) {
  const initials = useMemo(() => getInitials(name), [name])
  if (avatar) {
    return <img src={avatar} alt={name} className="h-7 w-7 rounded-full border border-neutral-200 object-cover bg-white shrink-0" />
  }
  return (
    <div className="h-7 w-7 rounded-full border border-neutral-200 bg-neutral-100 text-neutral-600 flex items-center justify-center text-[10px] font-semibold shrink-0">
      {initials}
    </div>
  )
}

function resolveMemberStatus(
  member: TeamMember,
  invocations: AgentInvocation[],
  workRequests: WorkRequest[],
): MemberStatus {
  const memberInvocations = invocations.filter((invocation) => invocation.memberId === member.id)
  if (memberInvocations.some((invocation) => invocation.status === 'RUNNING')) return 'running'
  if (memberInvocations.some((invocation) => invocation.status === 'WAITING_ROOM_REPLY')) return 'waiting room reply'
  if (memberInvocations.some((invocation) => invocation.status === 'QUEUED')) return 'queued'

  const pendingWorkRequest = workRequests.find(
    (workRequest) =>
      workRequest.targetMemberId === member.id
      && (workRequest.status === 'PENDING_APPROVAL' || workRequest.status === 'QUEUED'),
  )
  if (pendingWorkRequest?.status === 'PENDING_APPROVAL') return 'pending approval'
  if (pendingWorkRequest?.status === 'QUEUED') return 'queued'
  return 'idle'
}

export function TeamStatusPanel({ teamRun }: TeamStatusPanelProps) {
  const { t } = useI18n()

  const members = teamRun.members ?? EMPTY_MEMBERS
  const workRequests = teamRun.workRequests ?? EMPTY_WORK_REQUESTS
  const invocations = teamRun.invocations ?? EMPTY_INVOCATIONS

  const activeInvocations = useMemo(
    () =>
      invocations
        .filter((invocation) =>
          invocation.status === 'RUNNING'
          || invocation.status === 'WAITING_ROOM_REPLY'
          || invocation.status === 'QUEUED',
        )
        .sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? '') - Date.parse(a.updatedAt ?? a.createdAt ?? '')),
    [invocations],
  )

  const recentInvocations = useMemo(
    () =>
      [...invocations]
        .filter((invocation) =>
          invocation.status === 'COMPLETED'
          || invocation.status === 'FAILED'
          || invocation.status === 'CANCELLED',
        )
        .sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? '') - Date.parse(a.updatedAt ?? a.createdAt ?? ''))
        .slice(0, 6),
    [invocations],
  )

  const queuedRequests = useMemo(
    () =>
      [...workRequests]
        .filter((request) => request.status === 'PENDING_APPROVAL' || request.status === 'QUEUED')
        .sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? '') - Date.parse(a.updatedAt ?? a.createdAt ?? '')),
    [workRequests],
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Layers3 size={14} className="text-neutral-500 shrink-0" />
          <span className="text-xs font-semibold text-neutral-900">{t('Team Status')}</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[10px] font-medium text-neutral-500">
          <span>{t('Team mode')}</span>
          <span className="text-neutral-700">{teamRun.mode}</span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
        {teamRun.reviewReason && (
          <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
            <div className="mb-1 font-medium text-neutral-700">{t('Review reason')}</div>
            <div>{teamRun.reviewReason}</div>
          </div>
        )}

        <section className="space-y-2">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            <Users size={13} />
            <span>{t('Members')}</span>
          </div>
          <div className="space-y-2">
            {members.length === 0 ? (
              <div className="rounded-md border border-dashed border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-500">
                {t('No members')}
              </div>
            ) : (
              members.map((member) => {
                const status = resolveMemberStatus(member, invocations, workRequests)
                return (
                  <div key={member.id} className="rounded-md border border-neutral-200 bg-white px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <Avatar name={member.name} avatar={member.avatar} />
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-neutral-900">{member.name}</div>
                          <div className="truncate text-[11px] text-neutral-500">
                            {member.providerId} · {member.workspacePolicy}
                          </div>
                        </div>
                      </div>
                      <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize', statusClass(status))}>
                        {t(statusLabel(status))}
                      </span>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            <MessageSquare size={13} />
            <span>{t('Queue')}</span>
          </div>
          <div className="space-y-2">
            {queuedRequests.length === 0 ? (
              <div className="rounded-md border border-dashed border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-500">
                {t('No queued work requests')}
              </div>
            ) : (
              queuedRequests.map((request) => {
                const member = members.find((item) => item.id === request.targetMemberId)
                return (
                  <div key={request.id} className="rounded-md border border-neutral-200 bg-white px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-neutral-900">
                          {member?.name ?? request.targetMemberId}
                        </div>
                        <div className="mt-0.5 text-[11px] text-neutral-500 line-clamp-2">
                          {request.instruction}
                        </div>
                      </div>
                      <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[10px] font-medium text-neutral-600">
                        {request.status}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-[11px] text-neutral-500">
                      <Clock3 size={11} />
                      <span>{formatTime(request.createdAt)}</span>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            <Bot size={13} />
            <span>{t('Active invocations')}</span>
          </div>
          <div className="space-y-2">
            {activeInvocations.length === 0 ? (
              <div className="rounded-md border border-dashed border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-500">
                {t('No active invocations')}
              </div>
            ) : (
              activeInvocations.map((invocation) => {
                const member = members.find((item) => item.id === invocation.memberId)
                return (
                  <div key={invocation.id} className="rounded-md border border-neutral-200 bg-white px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-neutral-900">
                          {member?.name ?? invocation.memberId}
                        </div>
                        <div className="mt-0.5 text-[11px] text-neutral-500">
                          {invocation.status} · {invocation.sessionId ? invocation.sessionId.slice(0, 8) : invocation.id.slice(0, 8)}
                        </div>
                      </div>
                      <RefreshCw size={12} className="text-neutral-400 shrink-0" />
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-[11px] text-neutral-500">
                      <Clock3 size={11} />
                      <span>{formatTime(invocation.updatedAt ?? invocation.createdAt)}</span>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            <RefreshCw size={13} />
            <span>{t('Recently completed')}</span>
          </div>
          <div className="space-y-2">
            {recentInvocations.length === 0 ? (
              <div className="rounded-md border border-dashed border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-500">
                {t('No completed invocations')}
              </div>
            ) : (
              recentInvocations.map((invocation) => {
                const member = members.find((item) => item.id === invocation.memberId)
                return (
                  <div key={invocation.id} className="rounded-md border border-neutral-200 bg-white px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-neutral-900">
                          {member?.name ?? invocation.memberId}
                        </div>
                        <div className="mt-0.5 text-[11px] text-neutral-500">{invocation.status}</div>
                      </div>
                      <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[10px] font-medium text-neutral-600">
                        {invocation.status}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-[11px] text-neutral-500">
                      <Clock3 size={11} />
                      <span>{formatTime(invocation.updatedAt ?? invocation.createdAt)}</span>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
