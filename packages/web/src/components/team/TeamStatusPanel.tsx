import { useMemo, useState } from 'react'
import { Ban, Check, ChevronDown, ChevronRight, Clock3, GitBranch, Layers3, MessageSquare, PanelRightOpen, Settings2, Square, Users, X } from 'lucide-react'
import { WorkspaceStatus, type AgentInvocation, type TeamMember, type TeamMemberStatus, type TeamRun, type Workspace, type WorkRequest } from '@agent-tower/shared'
import { MemberAvatar } from './MemberAvatar'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { buildWorkspaceViews, getWorkspaceBranchLabel } from '@/components/workspace/team-workspace-view'
import { ACTIVE_ROOM_INVOCATION_STATUSES } from './room-timeline-items'
import {
  useApproveWorkRequest,
  useRejectWorkRequest,
  useStopMemberWork,
} from '@/hooks/use-team-run'
import { TeamMemberManageDialog } from './TeamMemberManageDialog'

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
const INLINE_PREVIEW_MAX_LENGTH = 240

type DisplayStatus = 'running' | 'waiting room reply' | 'queued' | 'session ended' | 'pending approval' | 'removed' | 'idle'

function toDisplayStatus(status: TeamMemberStatus): DisplayStatus {
  switch (status) {
    case 'RUNNING':
      return 'running'
    case 'WAITING':
    case 'WAITING_ROOM_REPLY':
      return 'waiting room reply'
    case 'QUEUED':
      return 'queued'
    case 'SESSION_ENDED':
      return 'session ended'
    case 'PENDING_APPROVAL':
      return 'pending approval'
    case 'REMOVED':
      return 'removed'
    case 'READY_FOR_REVIEW':
    case 'COMPLETED':
    case 'FAILED':
    case 'CANCELLED':
    case 'IDLE':
    default:
      return 'idle'
  }
}

const DISPLAY_STATUS_SORT_ORDER: Record<DisplayStatus, number> = {
  'running': 0,
  'waiting room reply': 1,
  'queued': 2,
  'session ended': 3,
  'pending approval': 4,
  'idle': 5,
  'removed': 6,
}

function formatTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function previewText(value?: string | null, maxLength = INLINE_PREVIEW_MAX_LENGTH) {
  const compact = (value ?? '').replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, maxLength - 3).trimEnd()}...`
}

function workRequestInstructionPreview(request?: WorkRequest | null) {
  if (!request) return ''
  return request.instructionPreview ?? previewText(request.instruction)
}

function statusLabel(status: DisplayStatus) {
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
    case 'removed':
      return 'Removed'
    case 'idle':
      return 'Idle'
  }
}

function statusClass(status: DisplayStatus) {
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
    case 'removed':
      return 'border-neutral-200 bg-neutral-50 text-neutral-400'
    case 'idle':
      return 'border-neutral-200 bg-white text-neutral-500'
  }
}

function statusDotClass(status: DisplayStatus) {
  switch (status) {
    case 'running':
      return 'bg-emerald-500'
    case 'waiting room reply':
      return 'bg-amber-500'
    case 'queued':
    case 'session ended':
      return 'bg-blue-500'
    case 'pending approval':
      return 'bg-neutral-400'
    case 'removed':
      return 'bg-neutral-300'
    case 'idle':
      return 'bg-neutral-300'
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

function getActiveInvocation(member: TeamMember, invocations: AgentInvocation[]) {
  return invocations.find(
    (invocation) =>
      invocation.memberId === member.id
      && ACTIVE_ROOM_INVOCATION_STATUSES.has(invocation.status),
  )
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
  const stopMemberWork = useStopMemberWork(teamRun.id)
  const [stopPromptMemberId, setStopPromptMemberId] = useState<string | null>(null)
  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null)
  const [workspacesExpanded, setWorkspacesExpanded] = useState(false)
  const [memberManageOpen, setMemberManageOpen] = useState(false)

  const members = teamRun.members ?? EMPTY_MEMBERS
  const activeMembers = useMemo(
    () => members.filter((member) => member.membershipStatus !== 'REMOVED'),
    [members],
  )
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

  const sortedMembers = useMemo(() => {
    return [...members]
      .map((member) => ({
        member,
        status: toDisplayStatus(member.status),
      }))
      .sort((a, b) => DISPLAY_STATUS_SORT_ORDER[a.status] - DISPLAY_STATUS_SORT_ORDER[b.status])
  }, [members])

  const pendingApprovalError =
    approveWorkRequest.isError
      ? approveWorkRequest.error
      : rejectWorkRequest.isError
        ? rejectWorkRequest.error
        : null

  const isPendingApprovalActionPending =
    approveWorkRequest.isPending
    || rejectWorkRequest.isPending

  const selectedWorkspace = workspaceViews.find((view) => view.workspace.id === selectedWorkspaceId)

  const messages = teamRun.messages ?? []
  const runningCount = sortedMembers.filter(({ status }) => status === 'running' || status === 'waiting room reply').length

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <TeamMemberManageDialog
        isOpen={memberManageOpen}
        onClose={() => setMemberManageOpen(false)}
        teamRun={teamRun}
      />
      {/* Header */}
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

      {/* Summary strip */}
      <div className="flex items-center gap-3 border-b border-neutral-100 px-4 py-1.5 shrink-0 text-[10px] text-neutral-500">
        <span className="inline-flex items-center gap-1" title={t('Messages')}>
          <MessageSquare size={11} className="text-neutral-400" />
          <span className="tabular-nums">{messages.length}</span>
        </span>
        <span className="inline-flex items-center gap-1" title={t('Members')}>
          <Users size={11} className="text-neutral-400" />
          <span className="tabular-nums">
            {runningCount > 0
              ? `${runningCount}/${activeMembers.length}`
              : activeMembers.length}
          </span>
          {runningCount > 0 && (
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          )}
        </span>
        {queuedRequests.length > 0 && (
          <span className="inline-flex items-center gap-1" title={t('Queue')}>
            <Clock3 size={11} className="text-neutral-400" />
            <span className="tabular-nums">{queuedRequests.length}</span>
          </span>
        )}
        {pendingApprovalRequests.length > 0 && (
          <span className="inline-flex items-center gap-1 text-amber-600" title={t('Pending approval')}>
            <Clock3 size={11} />
            <span className="tabular-nums">{pendingApprovalRequests.length}</span>
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-app-thin px-4 py-3 space-y-3">
        {/* ── Layer 1: Pending Approval (action area, only shown when data exists) ── */}
        {pendingApprovalRequests.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-amber-600">
              <Clock3 size={13} />
              <span>{t('Pending approval')}</span>
              <span className="ml-auto rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                {pendingApprovalRequests.length}
              </span>
            </div>
            <div className="space-y-1.5">
              {pendingApprovalRequests.map((request) => {
                const member = members.find((item) => item.id === request.targetMemberId)
                const isApprovePending = approveWorkRequest.isPending && approveWorkRequest.variables === request.id
                const isRejectPending = rejectWorkRequest.isPending && rejectWorkRequest.variables === request.id

                return (
                  <div key={request.id} className="rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <MemberAvatar name={member?.name ?? 'Agent'} avatar={member?.avatar ?? null} className="h-4 w-4 text-[8px]" />
                          <span className="truncate text-xs font-medium text-neutral-900">
                            {member?.name ?? request.targetMemberId}
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] leading-relaxed text-neutral-600 line-clamp-2">
                          {workRequestInstructionPreview(request)}
                        </div>
                      </div>
                    </div>
                    <div className="mt-1.5 flex items-center gap-x-2 text-[10px] text-neutral-400">
                      <span>{t(requesterLabel(request.requesterType))}</span>
                      <span>{formatTime(request.createdAt)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => approveWorkRequest.mutate(request.id)}
                        disabled={isPendingApprovalActionPending}
                        className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Check size={11} />
                        <span className="truncate">{isApprovePending ? t('Approving') : t('Approve')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => rejectWorkRequest.mutate(request.id)}
                        disabled={isPendingApprovalActionPending}
                        className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-2 text-[11px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <X size={11} />
                        <span className="truncate">{isRejectPending ? t('Rejecting') : t('Reject')}</span>
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
            {pendingApprovalError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {getErrorMessage(pendingApprovalError, t('Failed to update work request'))}
              </div>
            )}
          </section>
        )}

        {/* ── Layer 2: Members (always visible, compact, sorted by status) ── */}
        <section className="space-y-1.5">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            <Users size={13} />
            <span>{t('Members')}</span>
            <span className="ml-auto text-[10px] font-normal text-neutral-400">{activeMembers.length}</span>
            <button
              type="button"
              onClick={() => setMemberManageOpen(true)}
              className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
              title={t('Manage Team Members')}
              aria-label={t('Manage Team Members')}
            >
              <Settings2 size={13} />
            </button>
          </div>

          {members.length === 0 ? (
            <div className="py-3 text-center text-xs text-neutral-400">{t('No members')}</div>
          ) : (
            <div className="space-y-px rounded-md border border-neutral-200 overflow-hidden">
              {sortedMembers.map(({ member, status }) => {
                const activeInvocation = getActiveInvocation(member, invocations)
                const memberInvocations = sortInvocationsDesc(
                  invocations.filter((invocation) => invocation.memberId === member.id),
                )
                const activeWorkRequest = activeInvocation ? workRequestById.get(activeInvocation.workRequestId) : undefined
                const isExpanded = expandedMemberId === member.id
                const isActive = status === 'running' || status === 'waiting room reply'
                const canStop = isActive && !!activeInvocation
                const isConfirmingStop = stopPromptMemberId === member.id
                const isStoppingMember = stopMemberWork.isPending && stopMemberWork.variables?.memberId === member.id

                return (
                  <div key={member.id} className={cn('bg-white', isExpanded && 'bg-neutral-50/50')}>
                    {/* Compact member row */}
                    <div className="flex items-center gap-2 px-3 py-2">
                      <MemberAvatar name={member.name} avatar={member.avatar} className="h-6 w-6 text-[10px] shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDotClass(status))} />
                          <span className="truncate text-xs font-medium text-neutral-900">{member.name}</span>
                          <span className={cn('shrink-0 rounded-full border px-1.5 py-px text-[9px] font-medium leading-tight', statusClass(status))}>
                            {t(statusLabel(status))}
                          </span>
                        </div>
                        {isActive && activeWorkRequest?.instruction && (
                          <div className="mt-0.5 truncate pl-3 text-[10px] text-neutral-500">
                            {workRequestInstructionPreview(activeWorkRequest)}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {canStop && (
                          <button
                            type="button"
                            onClick={() => setStopPromptMemberId(isConfirmingStop ? null : member.id)}
                            disabled={stopMemberWork.isPending}
                            className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                            title={t('Stop')}
                            aria-label={t('Stop')}
                          >
                            <Square size={12} />
                          </button>
                        )}
                        {activeInvocation?.sessionId && onViewInvocationSession && (
                          <button
                            type="button"
                            onClick={() => onViewInvocationSession(activeInvocation.sessionId!)}
                            className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
                            title={t('View log')}
                            aria-label={t('View log')}
                          >
                            <PanelRightOpen size={12} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setExpandedMemberId(isExpanded ? null : member.id)}
                          className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600"
                          title={t('Details')}
                          aria-label={t('Details')}
                          aria-expanded={isExpanded}
                        >
                          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                      </div>
                    </div>

                    {/* Stop confirmation */}
                    {canStop && isConfirmingStop && (
                      <div className="mx-3 mb-2 rounded-md border border-neutral-200 bg-neutral-50 p-2">
                        <div className="mb-1.5 text-[11px] text-neutral-600">{t('Stop running work?')}</div>
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              stopMemberWork.mutate(
                                { memberId: member.id, cancelQueued: false },
                                { onSuccess: () => setStopPromptMemberId(null) },
                              )
                            }}
                            disabled={stopMemberWork.isPending}
                            className="inline-flex h-6 items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 text-[11px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Square size={10} />
                            <span>{isStoppingMember && stopMemberWork.variables?.cancelQueued === false ? t('Stopping') : t('Stop only')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              stopMemberWork.mutate(
                                { memberId: member.id, cancelQueued: true },
                                { onSuccess: () => setStopPromptMemberId(null) },
                              )
                            }}
                            disabled={stopMemberWork.isPending}
                            className="inline-flex h-6 items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Ban size={10} />
                            <span>{isStoppingMember && stopMemberWork.variables?.cancelQueued === true ? t('Stopping') : t('Stop + clear queue')}</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Expanded: member detail + invocation history */}
                    {isExpanded && (
                      <div className="border-t border-neutral-100 px-3 py-2">
                        <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-neutral-400">
                          <span>{member.providerId}</span>
                          <span className="h-0.5 w-0.5 rounded-full bg-neutral-300" />
                          <span>{member.workspacePolicy}</span>
                          <span className="h-0.5 w-0.5 rounded-full bg-neutral-300" />
                          <span>{member.sessionPolicy === 'resume_last' ? t('Resume last session') : t('New session per request')}</span>
                        </div>
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium text-neutral-500">{t('Invocation history')}</span>
                          <span className="text-[10px] text-neutral-400">{memberInvocations.length}</span>
                        </div>
                        {memberInvocations.length === 0 ? (
                          <div className="py-2 text-center text-[11px] text-neutral-400">{t('No invocations yet')}</div>
                        ) : (
                          <div className="space-y-1">
                            {memberInvocations.map((invocation) => {
                              const workRequest = workRequestById.get(invocation.workRequestId)
                              const canOpenSession = Boolean(invocation.sessionId && onViewInvocationSession)
                              return (
                                <div key={invocation.id} className="rounded-md border border-neutral-100 bg-white px-2.5 py-1.5">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                        <span className={cn('rounded-full border px-1.5 py-px text-[9px] font-medium leading-tight', invocationStatusClass(invocation.status))}>
                                          {invocation.status}
                                        </span>
                                        <span className="text-[10px] text-neutral-400">
                                          {formatTime(invocation.updatedAt ?? invocation.createdAt)}
                                        </span>
                                      </div>
                                      <div className="mt-0.5 truncate text-[11px] text-neutral-500">
                                        {workRequestInstructionPreview(workRequest) || invocation.workRequestId}
                                      </div>
                                    </div>
                                    {canOpenSession && (
                                      <button
                                        type="button"
                                        onClick={() => invocation.sessionId && onViewInvocationSession?.(invocation.sessionId)}
                                        className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-neutral-200 bg-white px-1.5 text-[10px] font-medium text-neutral-600 transition-colors hover:bg-neutral-100"
                                        title={t('View log')}
                                        aria-label={t('View log')}
                                      >
                                        <PanelRightOpen size={10} />
                                        <span>{t('Log')}</span>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Separator between members except last */}
                    {sortedMembers[sortedMembers.length - 1]?.member.id !== member.id && !isExpanded && (
                      <div className="mx-3 border-b border-neutral-100" />
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {stopMemberWork.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {getErrorMessage(stopMemberWork.error, t('Failed to stop member work'))}
            </div>
          )}
        </section>

        {/* ── Layer 3: Queue (only shown when data exists) ── */}
        {queuedRequests.length > 0 && (
          <section className="space-y-1.5">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
              <Clock3 size={13} />
              <span>{t('Queue')}</span>
              <span className="ml-auto rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600">
                {queuedRequests.length}
              </span>
            </div>
            <div className="space-y-1">
              {queuedRequests.map((request) => {
                const member = members.find((item) => item.id === request.targetMemberId)
                return (
                  <div key={request.id} className="rounded-md border border-neutral-200 bg-white px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <MemberAvatar name={member?.name ?? 'Agent'} avatar={member?.avatar ?? null} className="h-4 w-4 text-[8px]" />
                          <span className="truncate text-xs font-medium text-neutral-900">
                            {member?.name ?? request.targetMemberId}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-neutral-500">
                          {workRequestInstructionPreview(request)}
                        </div>
                      </div>
                      <span className="shrink-0 text-[10px] text-neutral-400">{formatTime(request.createdAt)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* ── Layer 4: Workspaces (collapsed by default) ── */}
        {workspaceViews.length > 0 && (
          <section className="space-y-1.5">
            <button
              type="button"
              onClick={() => setWorkspacesExpanded((prev) => !prev)}
              className="flex w-full items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500 transition-colors hover:text-neutral-700"
              aria-expanded={workspacesExpanded}
              aria-label={t('Workspaces')}
            >
              <Layers3 size={13} />
              <span>{t('Workspaces')}</span>
              <span className="ml-auto flex items-center gap-1.5">
                {selectedWorkspace && (
                  <span className="max-w-[120px] truncate font-mono text-[10px] font-normal text-neutral-400">
                    {getWorkspaceBranchLabel(selectedWorkspace.workspace)}
                  </span>
                )}
                <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600">
                  {workspaceViews.length}
                </span>
                {workspacesExpanded ? (
                  <ChevronDown size={13} className="text-neutral-400" />
                ) : (
                  <ChevronRight size={13} className="text-neutral-400" />
                )}
              </span>
            </button>

            {workspacesExpanded && (
              <div className="space-y-1.5">
                {workspaceViews.map((view) => {
                  const isSelected = selectedWorkspaceId === view.workspace.id
                  return (
                    <div
                      key={view.workspace.id}
                      className={cn(
                        'rounded-md border bg-white px-3 py-2',
                        isSelected ? 'border-neutral-400 shadow-sm' : 'border-neutral-200',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <span className="truncate text-xs font-medium text-neutral-900">{t(view.displayName)}</span>
                            <span className={cn('shrink-0 rounded-full border px-1.5 py-px text-[9px] font-medium leading-tight', workspaceRoleClass(view.roleLabel))}>
                              {t(view.roleLabel)}
                            </span>
                            <span className={cn('shrink-0 rounded-full border px-1.5 py-px text-[9px] font-medium leading-tight', workspaceStatusClass(view.workspace.status))}>
                              {view.workspace.status}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[10px] text-neutral-500">
                            {getWorkspaceBranchLabel(view.workspace)}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-neutral-400">
                            {view.ownerName && <span>{t('Owner')}: {view.ownerName}</span>}
                            {view.parentBranchName && <span>{t('Parent')}: {view.parentBranchName}</span>}
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
                })}
              </div>
            )}
          </section>
        )}

        {/* Idle state hint when everything is quiet */}
        {pendingApprovalRequests.length === 0
          && queuedRequests.length === 0
          && sortedMembers.every(({ status }) => status === 'idle')
          && (
            <div className="py-2 text-center text-[11px] text-neutral-400">
              {t('All members idle')}
            </div>
          )}
      </div>
    </div>
  )
}
