import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import type { ChangeEvent } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import {
  ArrowDown,
  ArrowUp,
  AtSign,
  ChevronDown,
  Clock3,
  MessageSquare,
  PanelRightOpen,
  Send,
  Users,
  X,
} from 'lucide-react'
import type { AgentInvocation, RoomMessage, StructuredMention, TeamMember, TeamRun } from '@agent-tower/shared'
import type { PostRoomMessageInput } from '@/hooks/use-team-run'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

interface RoomTimelineProps {
  teamRun: TeamRun
  messages: RoomMessage[]
  readOnly?: boolean
  readOnlyMessage?: string
  onSendMessage: (input: PostRoomMessageInput) => Promise<unknown>
  onViewInvocationSession?: (sessionId: string) => void
}

const ACTIVE_INVOCATION_STATUSES = new Set<AgentInvocation['status']>([
  'RUNNING',
  'WAITING_ROOM_REPLY',
  'QUEUED',
])

function formatTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatKind(kind: RoomMessage['kind']) {
  return kind.replace(/_/g, ' ')
}

function formatMemberStatus(invocation?: AgentInvocation, pendingWorkRequest?: boolean) {
  if (invocation?.status === 'RUNNING') return 'running'
  if (invocation?.status === 'WAITING_ROOM_REPLY') return 'waiting room reply'
  if (invocation?.status === 'QUEUED') return 'queued'
  if (pendingWorkRequest) return 'pending approval'
  return 'idle'
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

function resolveSenderMember(
  message: RoomMessage,
  memberById: Map<string, TeamMember>,
  invocationById: Map<string, AgentInvocation>,
) {
  if (message.senderType !== 'agent') return null
  if (message.senderId && memberById.has(message.senderId)) {
    return memberById.get(message.senderId) ?? null
  }
  if (message.senderInvocationId) {
    const invocation = invocationById.get(message.senderInvocationId)
    if (invocation?.memberId && memberById.has(invocation.memberId)) {
      return memberById.get(invocation.memberId) ?? null
    }
  }
  return null
}

function Avatar({
  name,
  avatar,
}: {
  name: string
  avatar?: string | null
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const initials = useMemo(() => getInitials(name), [name])

  if (avatar && !imageFailed) {
    return (
      <img
        src={avatar}
        alt={name}
        onError={() => setImageFailed(true)}
        className="h-7 w-7 rounded-full border border-neutral-200 object-cover bg-white shrink-0"
      />
    )
  }

  return (
    <div className="h-7 w-7 rounded-full border border-neutral-200 bg-neutral-100 text-neutral-600 flex items-center justify-center text-[10px] font-semibold shrink-0">
      {initials}
    </div>
  )
}

export function RoomTimeline({
  teamRun,
  messages,
  readOnly,
  readOnlyMessage,
  onSendMessage,
  onViewInvocationSession,
}: RoomTimelineProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false)
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    resize: 'smooth',
    initial: 'instant',
  })

  const memberById = useMemo(() => {
    return new Map((teamRun.members ?? []).map((member) => [member.id, member]))
  }, [teamRun.members])

  const invocationById = useMemo(() => {
    return new Map((teamRun.invocations ?? []).map((invocation) => [invocation.id, invocation]))
  }, [teamRun.invocations])

  const messageList = useMemo(() => {
    return [...messages].sort((a, b) => {
      const aTime = Date.parse(a.createdAt ?? '')
      const bTime = Date.parse(b.createdAt ?? '')
      return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime)
    })
  }, [messages])

  const activeInvocations = useMemo(() => {
    const invocations = (teamRun.invocations ?? [])
      .filter((invocation) => ACTIVE_INVOCATION_STATUSES.has(invocation.status))
      .sort((a, b) => {
        const aTime = Date.parse(a.updatedAt ?? a.createdAt ?? '')
        const bTime = Date.parse(b.updatedAt ?? b.createdAt ?? '')
        return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime)
      })

    return invocations.map((invocation) => ({
      invocation,
      member: memberById.get(invocation.memberId) ?? null,
    }))
  }, [teamRun.invocations, memberById])

  const selectedMembers = useMemo(() => {
    return selectedMemberIds
      .map((memberId) => memberById.get(memberId))
      .filter((member): member is TeamMember => Boolean(member))
  }, [memberById, selectedMemberIds])

  const handleToggleMention = useCallback((memberId: string) => {
    setSelectedMemberIds((current) =>
      current.includes(memberId)
        ? current.filter((id) => id !== memberId)
        : [...current, memberId],
    )
  }, [])

  const handleDraftChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value)
    setSubmitError(null)
    const element = event.target
    element.style.height = 'auto'
    element.style.height = `${Math.max(72, Math.min(element.scrollHeight, 240))}px`
  }, [])

  const handleSubmit = useCallback(async () => {
    if (readOnly || isSubmitting) return
    const content = draft.trim()
    if (!content) return

    setIsSubmitting(true)
    setSubmitError(null)
    try {
      const mentions: StructuredMention[] = selectedMembers.map((member) => ({
        memberId: member.id,
        label: member.name,
      }))
      await onSendMessage({ content, mentions, senderType: 'user' })
      setDraft('')
      setSelectedMemberIds([])
      setMentionPickerOpen(false)
      if (textareaRef.current) {
        textareaRef.current.style.height = '72px'
      }
      requestAnimationFrame(() => scrollToBottom())
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to send room message')
    } finally {
      setIsSubmitting(false)
    }
  }, [draft, isSubmitting, onSendMessage, readOnly, scrollToBottom, selectedMembers])

  useEffect(() => {
    setDraft('')
    setSelectedMemberIds([])
    setMentionPickerOpen(false)
    setSubmitError(null)
    if (textareaRef.current) {
      textareaRef.current.style.height = '72px'
    }
  }, [teamRun.id])

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare size={14} className="text-neutral-500 shrink-0" />
          <span className="text-xs font-semibold text-neutral-900">{t('Team room')}</span>
          <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
            {messageList.length}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-neutral-500 shrink-0">
          <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 font-medium text-neutral-600">
            {teamRun.mode}
          </span>
          {teamRun.reviewReason && (
            <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 font-medium text-neutral-600">
              {teamRun.reviewReason}
            </span>
          )}
        </div>
      </div>

      {activeInvocations.length > 0 && (
        <div className="border-b border-neutral-200 bg-neutral-50/70 px-4 py-3 shrink-0">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            <Users size={13} />
            <span>{t('Active invocations')}</span>
          </div>
          <div className="space-y-2">
            {activeInvocations.map(({ invocation, member }) => {
              const canOpenSession = Boolean(invocation.sessionId && onViewInvocationSession)
              const statusLabel = formatMemberStatus(invocation)
              return (
                <div
                  key={invocation.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 bg-white px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar
                      name={member?.name ?? t('Agent')}
                      avatar={member?.avatar ?? null}
                    />
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-neutral-900">
                        {member?.name ?? t('Agent')}
                      </div>
                      <div className="truncate text-[11px] text-neutral-500">
                        {t(statusLabel)}
                        {invocation.sessionId ? ` · ${invocation.sessionId.slice(0, 8)}…` : ''}
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={!canOpenSession}
                    onClick={() => invocation.sessionId && onViewInvocationSession?.(invocation.sessionId)}
                  >
                    <PanelRightOpen size={12} />
                    <span>{t('View details')}</span>
                  </Button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        <div ref={scrollRef} className="h-full overflow-y-auto px-4 py-4">
          <div ref={contentRef} className="space-y-3">
            {messageList.length === 0 ? (
              <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-200 bg-neutral-50 text-neutral-500">
                <Users size={24} className="text-neutral-400" />
                <span className="text-sm">{t('No room messages yet')}</span>
              </div>
            ) : (
              messageList.map((message) => {
                const senderMember = resolveSenderMember(message, memberById, invocationById)
                const senderName =
                  message.senderType === 'user'
                    ? t('你')
                    : message.senderType === 'system'
                      ? t('System')
                      : senderMember?.name ?? t('Agent')
                const isUser = message.senderType === 'user'
                const isSystem = message.senderType === 'system'
                const kindLabel = formatKind(message.kind)
                const mentions = message.mentions ?? []
                const workRequestCount = message.workRequestIds?.length ?? 0

                return (
                  <div
                    key={message.id}
                    className={cn(
                      'flex',
                      isUser ? 'justify-end' : isSystem ? 'justify-center' : 'justify-start',
                    )}
                  >
                    <div className={cn('max-w-[min(100%,44rem)]', isUser ? 'ml-12' : isSystem ? 'mx-auto' : 'mr-12')}>
                      <div
                        className={cn(
                          'rounded-lg border px-3 py-2 shadow-sm',
                          isUser
                            ? 'border-neutral-900 bg-neutral-900 text-white'
                            : isSystem
                              ? 'border-amber-200 bg-amber-50 text-amber-900'
                              : 'border-neutral-200 bg-white text-neutral-900',
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2">
                            {!isUser && !isSystem && (
                              <Avatar
                                name={senderName}
                                avatar={senderMember?.avatar ?? null}
                              />
                            )}
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-xs font-semibold">
                                  {senderName}
                                </span>
                                {message.kind !== 'chat' && (
                                  <span
                                    className={cn(
                                      'rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                                      isUser
                                        ? 'bg-white/15 text-white/85'
                                        : isSystem
                                          ? 'bg-amber-100 text-amber-700'
                                          : 'bg-neutral-100 text-neutral-500',
                                    )}
                                  >
                                    {kindLabel}
                                  </span>
                                )}
                              </div>
                              <div className={cn('flex items-center gap-2 text-[11px]', isUser ? 'text-white/65' : 'text-neutral-500')}>
                                <Clock3 size={11} />
                                <span>{formatTime(message.createdAt)}</span>
                              </div>
                            </div>
                          </div>
                          {message.kind !== 'chat' && isUser && (
                            <span className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/70">
                              {kindLabel}
                            </span>
                          )}
                        </div>

                        <div className={cn('mt-2 text-sm leading-relaxed whitespace-pre-wrap break-words', isUser ? 'text-white' : 'text-neutral-800')}>
                          {message.content}
                        </div>

                        {(mentions.length > 0 || workRequestCount > 0) && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {mentions.map((mention) => {
                              const mentionMember = memberById.get(mention.memberId)
                              return (
                                <span
                                  key={`${message.id}-${mention.memberId}`}
                                  className={cn(
                                    'rounded-full px-2 py-0.5 text-[10px] font-medium',
                                    isUser
                                      ? 'bg-white/15 text-white/85'
                                      : 'bg-neutral-100 text-neutral-600',
                                  )}
                                >
                                  @{mention.label ?? mentionMember?.name ?? mention.memberId}
                                </span>
                              )
                            })}
                            {workRequestCount > 0 && (
                              <span
                                className={cn(
                                  'rounded-full px-2 py-0.5 text-[10px] font-medium',
                                  isUser
                                    ? 'bg-white/15 text-white/85'
                                    : 'bg-blue-50 text-blue-700',
                                )}
                              >
                                {t('Work requests')}: {workRequestCount}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {!isAtBottom && (
          <button
            type="button"
            onClick={() => scrollToBottom()}
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-neutral-200 bg-white/90 px-3 py-1.5 text-xs text-neutral-600 shadow-md backdrop-blur-sm hover:bg-white hover:text-neutral-900 transition-colors"
          >
            <ArrowDown size={14} />
            <span>{t('Back to bottom')}</span>
          </button>
        )}
      </div>

      <div className="shrink-0 border-t border-neutral-200 px-4 py-3">
        {readOnly ? (
          <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-500">
            {readOnlyMessage ?? t('This project is read-only')}
          </div>
        ) : (
          <div className="rounded-lg border border-neutral-200 bg-white shadow-sm">
            {selectedMembers.length > 0 && (
              <div className="flex flex-wrap gap-1 border-b border-neutral-100 px-3 pt-3">
                {selectedMembers.map((member) => (
                  <button
                    key={member.id}
                    type="button"
                    onClick={() => handleToggleMention(member.id)}
                    className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[11px] text-neutral-700 hover:border-neutral-300 hover:bg-neutral-100"
                  >
                    <span>@{member.name}</span>
                    <X size={10} />
                  </button>
                ))}
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={draft}
              onChange={handleDraftChange}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.repeat && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void handleSubmit()
                }
              }}
              placeholder={t('Message the team room...')}
              className="w-full resize-none border-0 bg-transparent px-3 py-3 text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none"
              style={{ minHeight: 72, maxHeight: 240 }}
            />

            <div className="flex items-center justify-between gap-3 border-t border-neutral-100 px-3 py-2">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant={mentionPickerOpen ? 'secondary' : 'outline'}
                  onClick={() => setMentionPickerOpen((current) => !current)}
                  disabled={selectedMembers.length === 0 && (teamRun.members ?? []).length === 0}
                >
                  <AtSign size={12} />
                  <span>{t('Mention members')}</span>
                  <ChevronDown size={12} className={cn('transition-transform', mentionPickerOpen && 'rotate-180')} />
                </Button>
                {selectedMembers.length > 0 && (
                  <span className="text-[11px] text-neutral-500">
                    {selectedMembers.length} {t('selected')}
                  </span>
                )}
              </div>

              <Button
                type="button"
                size="sm"
                onClick={() => void handleSubmit()}
                disabled={readOnly || isSubmitting || !draft.trim()}
              >
                {isSubmitting ? (
                  <>
                    <ArrowUp size={14} />
                    <span>{t('Sending...')}</span>
                  </>
                ) : (
                  <>
                    <Send size={14} />
                    <span>{t('Send')}</span>
                  </>
                )}
              </Button>
            </div>

            {mentionPickerOpen && (teamRun.members ?? []).length > 0 && (
              <div className="border-t border-neutral-100 px-3 py-3">
                <div className="mb-2 text-[11px] uppercase tracking-wide text-neutral-500">
                  {t('Mention checklist')}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(teamRun.members ?? []).map((member) => {
                    const selected = selectedMemberIds.includes(member.id)
                    return (
                      <button
                        key={member.id}
                        type="button"
                        onClick={() => handleToggleMention(member.id)}
                        className={cn(
                          'flex items-center gap-2 rounded-md border px-2 py-2 text-left transition-colors',
                          selected
                            ? 'border-neutral-900 bg-neutral-50'
                            : 'border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50',
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-4 w-4 items-center justify-center rounded border text-[10px]',
                            selected
                              ? 'border-neutral-900 bg-neutral-900 text-white'
                              : 'border-neutral-300 bg-white text-transparent',
                          )}
                        >
                          {selected ? '✓' : ''}
                        </span>
                        <Avatar
                          name={member.name}
                          avatar={member.avatar}
                        />
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-neutral-900">{member.name}</div>
                          <div className="truncate text-[11px] text-neutral-500">
                            {member.providerId} · {member.workspacePolicy}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {submitError && (
              <div className="border-t border-neutral-100 px-3 py-2 text-xs text-red-600">
                {submitError}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
