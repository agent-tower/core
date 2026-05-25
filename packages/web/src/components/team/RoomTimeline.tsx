import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import {
  ArrowDown,
  ArrowUp,
  AtSign,
  Clock3,
  MessageSquare,
  PanelRightOpen,
  Users,
} from 'lucide-react'
import { Streamdown } from 'streamdown'
import type { UrlTransform } from 'streamdown'
import type { AgentInvocation, RoomMessage, StructuredMention, TeamMember, TeamRun } from '@agent-tower/shared'
import type { PostRoomMessageInput } from '@/hooks/use-team-run'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import 'streamdown/styles.css'

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

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

const attachmentUrlTransform: UrlTransform = (url) => {
  if (url.includes('://')) return url
  if (url.startsWith('/api/')) return url
  if (url.startsWith('/')) {
    return `${API_BASE_URL}/attachments/by-path?path=${encodeURIComponent(url)}`
  }
  return url
}

const MarkdownImage = ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
  <a href={src} target="_blank" rel="noopener noreferrer" className="inline-block">
    <img
      src={src}
      alt={alt}
      {...props}
      className="max-w-[300px] max-h-[200px] object-contain rounded-lg border border-neutral-200 cursor-pointer hover:opacity-90 transition-opacity"
    />
  </a>
)

const streamdownComponents = { img: MarkdownImage }

function formatTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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

function findInlineMention(value: string, cursor: number) {
  const beforeCursor = value.slice(0, cursor)
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/)
  if (!match || match.index == null) return null

  return {
    start: match.index + match[1].length,
    end: cursor,
    query: match[2] ?? '',
  }
}

function memberMatchesQuery(member: TeamMember, query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  const fields = [member.name, member.providerId, ...(member.aliases ?? [])]
  return fields.some((field) => field.toLowerCase().includes(normalized))
}

function getMentionLabels(member: TeamMember) {
  return Array.from(new Set([member.name, ...(member.aliases ?? [])]
    .map((label) => label.trim())
    .filter(Boolean)))
}

function hasInlineMention(content: string, member: TeamMember) {
  return getMentionLabels(member).some((label) => content.includes(`@${label}`))
}

function findMentionedMembers(content: string, members: TeamMember[]) {
  return members.filter((member) => hasInlineMention(content, member))
}

function getMentionLabel(mention: StructuredMention, memberById: Map<string, TeamMember>) {
  return mention.label ?? memberById.get(mention.memberId)?.name ?? mention.memberId
}

function getDisplayContent(message: RoomMessage, memberById: Map<string, TeamMember>) {
  const mentions = message.mentions ?? []
  if (mentions.length === 0) return message.content

  const missingLabels = mentions
    .map((mention) => getMentionLabel(mention, memberById))
    .filter((label) => label && !message.content.includes(`@${label}`))

  if (missingLabels.length === 0) return message.content

  const suffix = missingLabels.map((label) => `@${label}`).join(' ')
  return message.content.trimEnd() ? `${message.content.trimEnd()} ${suffix}` : suffix
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

function RoomMessageMarkdown({
  content,
  isUser,
}: {
  content: string
  isUser?: boolean
}) {
  return (
    <div
      className={cn(
        'prose prose-sm max-w-none break-words',
        'prose-p:my-2 prose-p:first:mt-0 prose-p:last:mb-0',
        'prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5',
        'prose-pre:my-2 prose-pre:max-w-full prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-neutral-950 prose-pre:p-3 prose-pre:text-xs',
        'prose-code:break-words prose-code:text-[0.92em]',
        'prose-headings:mb-2 prose-headings:mt-3 prose-headings:font-semibold',
        'prose-hr:my-3',
        isUser ? 'text-neutral-900 prose-strong:text-neutral-900' : 'text-neutral-800 prose-strong:text-neutral-900',
      )}
    >
      <Streamdown urlTransform={attachmentUrlTransform} components={streamdownComponents}>
        {content}
      </Streamdown>
    </div>
  )
}

function Avatar({
  name,
  avatar,
  className,
}: {
  name: string
  avatar?: string | null
  className?: string
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const initials = useMemo(() => getInitials(name), [name])

  if (avatar && !imageFailed) {
    return (
      <img
        src={avatar}
        alt={name}
        onError={() => setImageFailed(true)}
        className={cn('h-7 w-7 rounded-full border border-neutral-200 object-cover bg-white shrink-0', className)}
      />
    )
  }

  return (
    <div className={cn('h-7 w-7 rounded-full border border-neutral-200 bg-neutral-100 text-neutral-600 flex items-center justify-center text-[10px] font-semibold shrink-0', className)}>
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
  const [inlineMention, setInlineMention] = useState<{ start: number; end: number; query: string } | null>(null)
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0)
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

  const mentionCandidates = useMemo(() => {
    const query = inlineMention?.query ?? ''
    return (teamRun.members ?? [])
      .filter((member) => memberMatchesQuery(member, query))
      .sort((a, b) => {
        const aSelected = selectedMemberIds.includes(a.id)
        const bSelected = selectedMemberIds.includes(b.id)
        if (aSelected !== bSelected) return aSelected ? 1 : -1
        return a.name.localeCompare(b.name)
      })
  }, [inlineMention?.query, selectedMemberIds, teamRun.members])

  const mentionMenuOpen = !readOnly && (mentionPickerOpen || Boolean(inlineMention)) && mentionCandidates.length > 0

  const syncInlineMention = useCallback((value: string, cursor: number | null | undefined) => {
    if (cursor == null) {
      setInlineMention(null)
      return
    }
    setInlineMention(findInlineMention(value, cursor))
    setHighlightedMentionIndex(0)
  }, [])

  const handleSelectMention = useCallback((member: TeamMember) => {
    setSelectedMemberIds((current) => current.includes(member.id) ? current : [...current, member.id])

    const inserted = `@${member.name} `
    if (inlineMention) {
      const nextDraft = `${draft.slice(0, inlineMention.start)}${inserted}${draft.slice(inlineMention.end)}`
      const nextCursor = inlineMention.start + inserted.length
      setDraft(nextDraft)
      setInlineMention(null)
      setMentionPickerOpen(false)
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
      })
      return
    }

    const prefix = draft.length === 0 || /\s$/.test(draft) ? '' : ' '
    const nextDraft = `${draft}${prefix}${inserted}`
    const nextCursor = nextDraft.length
    setDraft(nextDraft)
    setMentionPickerOpen(false)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }, [draft, inlineMention])

  const handleDraftChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value
    setDraft(value)
    setSubmitError(null)
    const element = event.target
    element.style.height = 'auto'
    element.style.height = `${Math.max(72, Math.min(element.scrollHeight, 240))}px`
    setMentionPickerOpen(false)
    setSelectedMemberIds(findMentionedMembers(value, teamRun.members ?? []).map((member) => member.id))
    syncInlineMention(value, element.selectionStart)
  }, [syncInlineMention, teamRun.members])

  const handleSubmit = useCallback(async () => {
    if (readOnly || isSubmitting) return
    const content = draft.trim()
    if (!content) return

    setIsSubmitting(true)
    setSubmitError(null)
    try {
      const mentionedMembers = findMentionedMembers(content, teamRun.members ?? [])
      const mentions: StructuredMention[] = mentionedMembers.map((member) => ({
        memberId: member.id,
        label: member.name,
      }))
      await onSendMessage({ content, mentions, senderType: 'user' })
      setDraft('')
      setSelectedMemberIds([])
      setMentionPickerOpen(false)
      setInlineMention(null)
      if (textareaRef.current) {
        textareaRef.current.style.height = '72px'
      }
      requestAnimationFrame(() => scrollToBottom())
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to send room message')
    } finally {
      setIsSubmitting(false)
    }
  }, [draft, isSubmitting, onSendMessage, readOnly, scrollToBottom, teamRun.members])

  const handleDraftKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    const isComposing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229

    if (mentionMenuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlightedMentionIndex((current) => (current + 1) % mentionCandidates.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlightedMentionIndex((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length)
        return
      }
      if ((event.key === 'Enter' && !isComposing) || event.key === 'Tab') {
        event.preventDefault()
        const member = mentionCandidates[highlightedMentionIndex] ?? mentionCandidates[0]
        if (member) handleSelectMention(member)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setInlineMention(null)
        setMentionPickerOpen(false)
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.repeat && !isComposing) {
      event.preventDefault()
      void handleSubmit()
    }
  }, [handleSelectMention, handleSubmit, highlightedMentionIndex, mentionCandidates, mentionMenuOpen])

  useEffect(() => {
    setDraft('')
    setSelectedMemberIds([])
    setMentionPickerOpen(false)
    setInlineMention(null)
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
        <div ref={scrollRef} className="h-full overflow-y-auto scrollbar-app-thin bg-white px-4 py-4">
          <div ref={contentRef} className="space-y-4">
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
                const mentions = message.mentions ?? []
                const workRequestCount = message.workRequestIds?.length ?? 0
                const displayContent = getDisplayContent(message, memberById)

                if (isSystem) {
                  return (
                    <div key={message.id} className="flex justify-center">
                      <div className="max-w-[min(100%,34rem)] rounded-2xl border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 shadow-sm">
                        <RoomMessageMarkdown content={displayContent} />
                      </div>
                    </div>
                  )
                }

                return (
                  <div
                    key={message.id}
                    className={cn(
                      'flex items-start gap-2',
                      isUser ? 'justify-end pl-10' : 'justify-start pr-10',
                    )}
                  >
                    {!isUser && (
                      <Avatar
                        name={senderName}
                        avatar={senderMember?.avatar ?? null}
                        className="mt-0.5 h-8 w-8 text-[11px]"
                      />
                    )}
                    <div className={cn('max-w-[min(74%,42rem)]', isUser ? 'items-end' : 'items-start')}>
                      <div
                        className={cn(
                          'mb-1 flex items-center gap-2 px-1 text-[11px] text-neutral-500',
                          isUser ? 'justify-end' : 'justify-start',
                        )}
                      >
                        <span className="truncate font-medium text-neutral-700">{senderName}</span>
                        <Clock3 size={11} />
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div
                        className={cn(
                          'rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm',
                          isUser
                            ? 'rounded-tr-sm bg-neutral-200 text-neutral-900 shadow-none'
                            : 'rounded-tl-sm border border-neutral-100 bg-white text-neutral-900 shadow-[0_1px_3px_rgba(15,23,42,0.04)]',
                        )}
                      >
                        <RoomMessageMarkdown content={displayContent} isUser={isUser} />

                        {workRequestCount > 0 && mentions.length === 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                                isUser
                                  ? 'bg-neutral-300/70 text-neutral-700'
                                  : 'bg-blue-50 text-blue-700',
                              )}
                            >
                              {t('Work requests')}: {workRequestCount}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                    {isUser && (
                      <Avatar
                        name={senderName}
                        avatar={null}
                        className="mt-0.5 h-8 w-8 border-neutral-200 bg-neutral-100 text-neutral-600 text-[11px]"
                      />
                    )}
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

      <div className="shrink-0 border-t border-transparent bg-white px-6 pb-6 pt-2">
        {readOnly ? (
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
            {readOnlyMessage ?? t('This project is read-only')}
          </div>
        ) : (
          <div className="relative rounded-xl border border-neutral-200 bg-white shadow-sm transition-all duration-200 hover:shadow-md focus-within:border-neutral-300 focus-within:shadow-md">
            {mentionMenuOpen && (
              <div className="absolute bottom-full left-3 z-20 mb-2 w-[min(24rem,calc(100vw-3rem))] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl">
                <div className="border-b border-neutral-100 px-3 py-2 text-xs font-medium text-neutral-500">
                  {inlineMention ? t('Mention members') : t('Team members')}
                </div>
                <div className="max-h-64 overflow-y-auto p-1">
                  {mentionCandidates.map((member, index) => {
                    const selected = selectedMemberIds.includes(member.id)
                    const highlighted = index === highlightedMentionIndex
                    return (
                      <button
                        key={member.id}
                        type="button"
                        onMouseEnter={() => setHighlightedMentionIndex(index)}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          handleSelectMention(member)
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors',
                          highlighted ? 'bg-neutral-100' : 'hover:bg-neutral-50',
                        )}
                      >
                        <Avatar
                          name={member.name}
                          avatar={member.avatar}
                          className="h-8 w-8 text-[11px]"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-neutral-900">{member.name}</span>
                            {selected && (
                              <span className="rounded-full bg-neutral-900 px-1.5 py-0.5 text-[10px] font-medium text-white">
                                {t('selected')}
                              </span>
                            )}
                          </div>
                          <div className="truncate text-xs text-neutral-500">
                            {member.aliases.length > 0 ? member.aliases.join(' / ') : member.providerId}
                          </div>
                        </div>
                        <AtSign size={15} className="text-neutral-400" />
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={draft}
              onChange={handleDraftChange}
              onKeyDown={handleDraftKeyDown}
              onClick={(event) => syncInlineMention(draft, event.currentTarget.selectionStart)}
              onSelect={(event) => syncInlineMention(draft, event.currentTarget.selectionStart)}
              placeholder={t('Message the team room...')}
              className="w-full resize-none border-none bg-transparent px-4 pb-2 pt-4 text-sm leading-relaxed text-neutral-900 placeholder-neutral-400 focus:outline-none"
              style={{ minHeight: 60, maxHeight: 220 }}
            />

            <div className="flex items-center justify-between px-2 pb-2 pt-1">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setMentionPickerOpen((current) => !current)
                    setInlineMention(null)
                    requestAnimationFrame(() => textareaRef.current?.focus())
                  }}
                  disabled={selectedMembers.length === 0 && (teamRun.members ?? []).length === 0}
                  title={t('Mention members')}
                  aria-label={t('Mention members')}
                  className={cn(
                    'rounded-lg p-2 transition-colors',
                    mentionPickerOpen
                      ? 'bg-neutral-100 text-neutral-700'
                      : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600',
                    selectedMembers.length === 0 && (teamRun.members ?? []).length === 0
                      ? 'cursor-not-allowed opacity-50'
                      : '',
                  )}
                >
                  <AtSign size={18} />
                </button>
                {selectedMembers.length > 0 && (
                  <span className="text-[11px] text-neutral-500">
                    {selectedMembers.length} {t('selected')}
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={readOnly || isSubmitting || !draft.trim()}
                title={isSubmitting ? t('Sending...') : t('Send')}
                aria-label={isSubmitting ? t('Sending...') : t('Send')}
                className={cn(
                  'rounded-lg p-2 transition-all duration-200',
                  draft.trim() && !readOnly && !isSubmitting
                    ? 'bg-neutral-900 text-white shadow-md hover:bg-black'
                    : 'cursor-not-allowed bg-transparent text-neutral-300',
                  isSubmitting ? 'opacity-70' : '',
                )}
              >
                <ArrowUp size={18} />
              </button>
            </div>

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
