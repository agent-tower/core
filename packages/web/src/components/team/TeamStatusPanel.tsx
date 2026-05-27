import { useMemo, useState } from 'react'
import { Ban, Bot, Check, ChevronDown, ChevronRight, Clock3, GitBranch, Layers3, MessageSquare, PanelRightOpen, RefreshCw, Square, Users, X } from 'lucide-react'
import { WorkspaceStatus, type AgentInvocation, type TeamMember, type TeamRun, type Workspace, type WorkRequest } from '@agent-tower/shared'
import { MemberAvatar } from './MemberAvatar'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { buildWorkspaceViews } from '@/components/workspace/team-workspace-view'
import { ACTIVE_ROOM_INVOCATION_STATUSES } from './room-timeline-items'
import {
  useApproveWorkRequest,
  useCancelWorkRequest,
  useRejectWorkRequest,
  useStopMemberWork,
} from '@/hooks/use-team-run'

interface TeamStatusPanelProps {
  teamRun: TeamRun
  workspaces?: Workspace[]
  selectedWorkspaceId?: string | null
  onSelectWorkspace?: (workspaceId: string) => void
  onViewInvocationSession?: (sessionId: string) => void
}

const EMPTY_MEMBERS: TeamMember[] = []
const EMPTY_WORK_REQUESTS: WorkRequest[] = []
const EMPTY_INVOCATIONS: AgentInvocation[] = []

type MemberStatus = 'running' | 'waiting room reply' | 'queued' | 'session ended' | 'pending approval' | 'idle'

function formatTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function statusLabel(status: MemberStatus) {
  switch (status) {
    case 'running':
      return 'Running'
    case 'waiting room reply':
      return 'Waiting room reply'
    case 'queued':
      return 'Queued'
    case 'session ended':
      return 'Session ended'
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
    case 'session ended':
      return 'border-blue-200 bg-blue-50 text-blue-700'
    case 'pending approval':
      return 'border-neutral-200 bg-neutral-50 text-neutral-600'
    case 'idle':
      return 'border-neutral-200 bg-white text-neutral-500'
  }
}

function requesterLabel(requesterType: WorkRequest['requesterType']) {
  switch (requesterType) {
    case 'user':
      return 'User'
    case 'agent':
      return 'Agent'
    case 'system':
      return 'System'
  }
}

function ifBusyLabel(ifBusy: WorkRequest['ifBusy']) {
  switch (ifBusy) {
    case 'queue':
      return 'Queue if busy'
    case 'cancel_current_and_start':
      return 'Cancel current if busy'
  }
}

function sessionPolicyLabel(sessionPolicy: TeamMember['sessionPolicy']) {
  switch (sessionPolicy) {
    case 'new_per_request':
      return 'New session per request'
    case 'resume_last':
      return 'Resume last session'
  }
}

function invocationStatusClass(status: AgentInvocation['status']) {
  switch (status) {
    case 'RUNNING':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700'
    case 'WAITING_ROOM_REPLY':
      return 'border-amber-200 bg-amber-50 text-amber-700'
    case 'QUEUED':
    case 'SESSION_ENDED':
      return 'border-blue-200 bg-blue-50 text-blue-700'
    case 'COMPLETED':
      return 'border-neutral-200 bg-neutral-50 text-neutral-700'
    case 'FAILED':
      return 'border-red-200 bg-red-50 text-red-700'
    case 'CANCELLED':
      return 'border-neutral-200 bg-white text-neutral-500'
  }
}

function workspaceStatusClass(status: WorkspaceStatus) {
  switch (status) {
    case WorkspaceStatus.ACTIVE:
      return 'border-emerald-200 bg-emerald-50 text-emerald-700'
    case WorkspaceStatus.MERGED:
      return 'border-blue-200 bg-blue-50 text-blue-700'
    case WorkspaceStatus.HIBERNATED:
      return 'border-amber-200 bg-amber-50 text-amber-700'
    case WorkspaceStatus.ABANDONED:
      return 'border-neutral-200 bg-neutral-50 text-neutral-500'
  }
}

function workspaceRoleClass(roleLabel: string) {
  switch (roleLabel) {
    case 'Main':
      return 'border-indigo-200 bg-indigo-50 text-indigo-700'
    case 'Child':
      return 'border-cyan-200 bg-cyan-50 text-cyan-700'
    default:
      return 'border-neutral-200 bg-neutral-50 text-neutral-600'
  }
}

function sortInvocationsDesc(invocations: AgentInvocation[]) {
  return [...invocations].sort(
    (a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? '') - Date.parse(a.updatedAt ?? a.createdAt ?? ''),
  )
}

function shortId(value?: string | null) {
  return value ? `${value.slice(0, 8)}...` : ''
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
  if (memberInvocations.some((invocation) => invocation.status === 'SESSION_ENDED')) return 'session ended'

  const pendingWorkRequest = workRequests.find(
    (workRequest) =>
      workRequest.targetMemberId === member.id
      && (workRequest.status === 'PENDING_APPROVAL' || workRequest.status === 'QUEUED'),
  )
  if (pendingWorkRequest?.status === 'PENDING_APPROVAL') return 'pending approval'
  if (pendingWorkRequest?.status === 'QUEUED') return 'queued'
  return 'idle'
}

export function TeamStatusPanel({
  teamRun,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onViewInvocationSession,
}: TeamStatusPanelProps) {
  const { t } = useI18n()
  const approveWorkRequest = useApproveWorkRequest(teamRun.id)
  const rejectWorkRequest = useRejectWorkRequest(teamRun.id)
  const cancelPendingWorkRequest = useCancelWorkRequest(teamRun.id)
  const cancelQueuedWorkRequest = useCancelWorkRequest(teamRun.id)
  const stopMemberWork = useStopMemberWork(teamRun.id)
  const [stopPromptInvocationId, setStopPromptInvocationId] = useState<string | null>(null)
  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null)

  const members = teamRun.members ?? EMPTY_MEMBERS
  const workRequests = teamRun.workRequests ?? EMPTY_WORK_REQUESTS
  const invocations = teamRun.invocations ?? EMPTY_INVOCATIONS
  const workspaceViews = useMemo(
    () => buildWorkspaceViews(workspaces, teamRun),
    [teamRun, workspaces],
  )

  const workRequestById = useMemo(
    () => new Map(workRequests.map((request) => [request.id, request])),
    [workRequests],
  )

  const roomMessageCount = teamRun.messages?.length ?? 0

  const activeInvocations = useMemo(
    () =>
      invocations
        .filter((invocation) => ACTIVE_ROOM_INVOCATION_STATUSES.has(invocation.status))
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

  const pendingApprovalRequests = useMemo(
    () =>
      [...workRequests]
        .filter((request) => request.status === 'PENDING_APPROVAL')
        .sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? '') - Date.parse(a.updatedAt ?? a.createdAt ?? '')),
    [workRequests],
  )

  const queuedRequests = useMemo(
    () =>
      [...workRequests]
        .filter((request) => request.status === 'QUEUED')
        .sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? '') - Date.parse(a.updatedAt ?? a.createdAt ?? '')),
    [workRequests],
  )

  const pendingApprovalError =
    approveWorkRequest.isError
      ? approveWorkRequest.error
      : rejectWorkRequest.isError
        ? rejectWorkRequest.error
        : cancelPendingWorkRequest.isError
          ? cancelPendingWorkRequest.error
          : null

  const queuedRequestError = cancelQueuedWorkRequest.isError
    ? cancelQueuedWorkRequest.error
    : null

  const isPendingApprovalActionPending =
    approveWorkRequest.isPending
    || rejectWorkRequest.isPending
    || cancelPendingWorkRequest.isPending

  const isQueuedCancelPending = cancelQueuedWorkRequest.isPending

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

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-app-thin px-4 py-4 space-y-4">
        <section className="space-y-2">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            <MessageSquare size={13} />
            <span>{t('Team room')}</span>
          </div>
          <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
              <span className="rounded-full border border-neutral-200 bg-white px-2 py-0.5 font-medium text-neutral-600">
                {t('Messages')}: {roomMessageCount}
              </span>
              <span className="rounded-full border border-neutral-200 bg-white px-2 py-0.5 font-medium text-neutral-600">
                {t('Team mode')}: {teamRun.mode}
              </span>
              {teamRun.reviewReason && (
                <span className="rounded-full border border-neutral-200 bg-white px-2 py-0.5 font-medium text-neutral-600">
                  {t('Review reason')}: {teamRun.reviewReason}
                </span>
              )}
            </div>
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            <Layers3 size={13} />
            <span>{t('Workspaces')}</span>
          </div>
          <div className="space-y-2">
            {workspaceViews.length === 0 ? (
              <div className="rounded-md border border-dashed border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-500">
                {t('No workspace')}
              </div>
            ) : (
              workspaceViews.map((view) => {
                const isSelected = selectedWorkspaceId === view.workspace.id
                return (
                  <div
                    key={view.workspace.id}
                    className={cn(
                      'rounded-md border bg-white px-3 py-2',
                      isSelected ? 'border-neutral-400 shadow-sm' : 'border-neutral-200',
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="truncate text-xs font-medium text-neutral-900">{t(view.displayName)}</span>
                          <span className={cn('shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium', workspaceRoleClass(view.roleLabel))}>
                            {t(view.roleLabel)}
                          </span>
                          <span className={cn('shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium', workspaceStatusClass(view.workspace.status))}>
                            {view.workspace.status}
                          </span>
                        </div>
                        <div className="mt-1 truncate font-mono text-[11px] text-neutral-500">
                          {view.workspace.branchName}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-neutral-400">
                          {view.ownerName && <span>{t('Owner')}: {view.ownerName}</span>}
                          {view.parentBranchName && <span>{t('Parent')}: {view.parentBranchName}</span>}
                          <span>{t('Workspace')}: {shortId(view.workspace.id)}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onSelectWorkspace?.(view.workspace.id)}
                        disabled={!onSelectWorkspace || isSelected}
                        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-2 text-[11px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                        title={t('View workspace')}
                      >
                        {isSelected ? <Check size={11} /> : <GitBranch size={11} />}
                        <span>{isSelected ? t('Selected') : t('Select')}</span>
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            <Clock3 size={13} />
            <span>{t('Pending approval')}</span>
          </div>
          <div className="space-y-2">
            {pendingApprovalRequests.length === 0 ? (
              <div className="rounded-md border border-dashed border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-500">
                {t('No pending approvals')}
              </div>
            ) : (
              pendingApprovalRequests.map((request) => {
                const member = members.find((item) => item.id === request.targetMemberId)
                const isApprovePending = approveWorkRequest.isPending && approveWorkRequest.variables === request.id
                const isRejectPending = rejectWorkRequest.isPending && rejectWorkRequest.variables === request.id
                const isCancelPending = cancelPendingWorkRequest.isPending && cancelPendingWorkRequest.variables === request.id

                return (
                  <div key={request.id} className="rounded-md border border-neutral-200 bg-white px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-neutral-900">
                          {member?.name ?? request.targetMemberId}
                        </div>
                        <div className="mt-0.5 text-[11px] leading-relaxed text-neutral-500 line-clamp-3">
                          {request.instruction}
                        </div>
                      </div>
                      <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                        {t('Pending approval')}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-neutral-500">
                      <span>{t('Requester')}: {t(requesterLabel(request.requesterType))}</span>
                      <span>{formatTime(request.createdAt)}</span>
                      <span>{t(ifBusyLabel(request.ifBusy))}</span>
                      <span>{t('Cancel queued')}: {t(request.cancelQueued ? 'Yes' : 'No')}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => approveWorkRequest.mutate(request.id)}
                        disabled={isPendingApprovalActionPending}
                        className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                        title={t('Approve')}
                      >
                        <Check size={11} />
                        <span className="truncate">{isApprovePending ? t('Approving') : t('Approve')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => rejectWorkRequest.mutate(request.id)}
                        disabled={isPendingApprovalActionPending}
                        className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-2 text-[11px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                        title={t('Reject')}
                      >
                        <X size={11} />
                        <span className="truncate">{isRejectPending ? t('Rejecting') : t('Reject')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => cancelPendingWorkRequest.mutate(request.id)}
                        disabled={isPendingApprovalActionPending}
                        className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                        title={t('Cancel')}
                      >
                        <Ban size={11} />
                        <span className="truncate">{isCancelPending ? t('Cancelling') : t('Cancel')}</span>
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
          {pendingApprovalError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {getErrorMessage(pendingApprovalError, t('Failed to update work request'))}
            </div>
          )}
        </section>

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
                const memberInvocations = sortInvocationsDesc(
                  invocations.filter((invocation) => invocation.memberId === member.id),
                )
                const latestInvocation = memberInvocations[0]
                const isExpanded = expandedMemberId === member.id
                return (
                  <div key={member.id} className="rounded-md border border-neutral-200 bg-white">
                    <button
                      type="button"
                      onClick={() => setExpandedMemberId(isExpanded ? null : member.id)}
                      className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-neutral-50"
                    >
                      <div className="flex min-w-0 items-start gap-2">
                        <MemberAvatar name={member.name} avatar={member.avatar} />
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-neutral-900">{member.name}</div>
                          <div className="truncate text-[11px] text-neutral-500">
                            {member.providerId} · {member.workspacePolicy} · {t(sessionPolicyLabel(member.sessionPolicy))}
                          </div>
                          {latestInvocation && (
                            <div className="mt-0.5 truncate text-[11px] text-neutral-400">
                              {t('Latest')}: {latestInvocation.status} · {formatTime(latestInvocation.updatedAt ?? latestInvocation.createdAt)}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize', statusClass(status))}>
                          {t(statusLabel(status))}
                        </span>
                        {isExpanded ? (
                          <ChevronDown size={14} className="text-neutral-400" />
                        ) : (
                          <ChevronRight size={14} className="text-neutral-400" />
                        )}
                      </div>
                    </button>
                    {isExpanded && (
                      <div className="border-t border-neutral-100 px-3 py-2">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium text-neutral-500">{t('Invocation history')}</span>
                          <span className="text-[10px] text-neutral-400">{memberInvocations.length}</span>
                        </div>
                        {memberInvocations.length === 0 ? (
                          <div className="rounded-md border border-dashed border-neutral-200 bg-neutral-50 px-3 py-3 text-xs text-neutral-500">
                            {t('No invocation history')}
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            {memberInvocations.map((invocation) => {
                              const workRequest = workRequestById.get(invocation.workRequestId)
                              const canOpenSession = Boolean(invocation.sessionId && onViewInvocationSession)
                              return (
                                <div key={invocation.id} className="rounded-md border border-neutral-100 bg-neutral-50/70 px-2.5 py-2">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                        <span className={cn('rounded-full border px-1.5 py-0.5 text-[10px] font-medium', invocationStatusClass(invocation.status))}>
                                          {invocation.status}
                                        </span>
                                        <span className="text-[10px] text-neutral-400">
                                          {formatTime(invocation.updatedAt ?? invocation.createdAt)}
                                        </span>
                                      </div>
                                      <div className="mt-1 truncate text-[11px] text-neutral-500">
                                        {workRequest?.instruction ?? invocation.workRequestId}
                                      </div>
                                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-neutral-400">
                                        <span>{t('Invocation')}: {shortId(invocation.id)}</span>
                                        {invocation.sessionId && <span>{t('Session')}: {shortId(invocation.sessionId)}</span>}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => invocation.sessionId && onViewInvocationSession?.(invocation.sessionId)}
                                      disabled={!canOpenSession}
                                      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 text-[11px] font-medium text-neutral-600 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                                      title={t('View details')}
                                    >
                                      <PanelRightOpen size={11} />
                                      <span>{t('View log')}</span>
                                    </button>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )}
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
                const isCancelPending = cancelQueuedWorkRequest.isPending && cancelQueuedWorkRequest.variables === request.id
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
                      <button
                        type="button"
                        onClick={() => cancelQueuedWorkRequest.mutate(request.id)}
                        disabled={isQueuedCancelPending}
                        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                        title={t('Cancel')}
                      >
                        <Ban size={11} />
                        <span>{isCancelPending ? t('Cancelling') : t('Cancel')}</span>
                      </button>
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
          {queuedRequestError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {getErrorMessage(queuedRequestError, t('Failed to cancel work request'))}
            </div>
          )}
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
                const canStop = ACTIVE_ROOM_INVOCATION_STATUSES.has(invocation.status) && !!member
                const isConfirmingStop = stopPromptInvocationId === invocation.id
                const isStoppingMember = stopMemberWork.isPending && stopMemberWork.variables?.memberId === member?.id
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
                      {canStop ? (
                        <button
                          type="button"
                          onClick={() => setStopPromptInvocationId(isConfirmingStop ? null : invocation.id)}
                          disabled={stopMemberWork.isPending}
                          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-2 text-[11px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                          title={t('Stop')}
                        >
                          <Square size={10} />
                          <span>{t('Stop')}</span>
                        </button>
                      ) : (
                        <RefreshCw size={12} className="text-neutral-400 shrink-0" />
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-[11px] text-neutral-500">
                      <Clock3 size={11} />
                      <span>{formatTime(invocation.updatedAt ?? invocation.createdAt)}</span>
                    </div>
                    {canStop && isConfirmingStop && (
                      <div className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 p-2">
                        <div className="mb-1.5 text-[11px] text-neutral-600">{t('Stop running work?')}</div>
                        <div className="grid grid-cols-1 gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              stopMemberWork.mutate(
                                { memberId: member.id, cancelQueued: false },
                                { onSuccess: () => setStopPromptInvocationId(null) },
                              )
                            }}
                            disabled={stopMemberWork.isPending}
                            className="inline-flex min-h-6 w-full items-center justify-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-1 text-[11px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Square size={10} />
                            <span>{isStoppingMember && stopMemberWork.variables?.cancelQueued === false ? t('Stopping') : t('Stop only')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              stopMemberWork.mutate(
                                { memberId: member.id, cancelQueued: true },
                                { onSuccess: () => setStopPromptInvocationId(null) },
                              )
                            }}
                            disabled={stopMemberWork.isPending}
                            className="inline-flex min-h-6 w-full items-center justify-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Ban size={10} />
                            <span>{isStoppingMember && stopMemberWork.variables?.cancelQueued === true ? t('Stopping') : t('Stop + clear queue')}</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
          {stopMemberWork.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {getErrorMessage(stopMemberWork.error, t('Failed to stop member work'))}
            </div>
          )}
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
