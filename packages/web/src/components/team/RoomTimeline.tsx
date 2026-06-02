import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useState, useRef } from 'react'
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import {
  ArrowDown,
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  ExternalLink,
  FileText,
  Paperclip,
  Users,
  X,
} from 'lucide-react'
import { Streamdown } from 'streamdown'
import type { UrlTransform } from 'streamdown'
import type { AgentInvocation, Attachment, RoomMessage, StructuredMention, TeamMember, TeamRun, WorkRequest } from '@agent-tower/shared'
import type { PostRoomMessageInput } from '@/hooks/use-team-run'
import { useAttachmentMetadata, useAttachments } from '@/hooks/use-attachments'
import { AttachmentPreview } from '@/components/ui/AttachmentPreview'
import {
  useApproveWorkRequest,
  useRejectWorkRequest,
  useStopMemberWork,
} from '@/hooks/use-team-run'
import { Button } from '@/components/ui/button'
import { MemberAvatar } from './MemberAvatar'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import {
  ROOM_MESSAGE_COLLAPSED_MAX_HEIGHT,
  isRoomMessageContentOverflowing,
} from './room-message-collapse'
import {
  addSelectedMemberId,
  buildStructuredMentionsFromSelectedMembers,
  removeSelectedMemberId,
} from './room-mentions'
import { ACTIVE_ROOM_INVOCATION_STATUSES, buildRoomTimelineItems } from './room-timeline-items'
import { ActiveWorkList } from './ActiveWorkList'
import { streamdownComponents } from '@/lib/streamdown-components'
import 'streamdown/styles.css'

interface RoomTimelineProps {
  teamRun: TeamRun
  messages: RoomMessage[]
  readOnly?: boolean
  readOnlyMessage?: string
  onSendMessage: (input: PostRoomMessageInput) => Promise<unknown>
  onViewInvocationSession?: (sessionId: string) => void
  compactComposer?: boolean
}

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

type PendingRoomMessageStatus = 'sending' | 'failed'
type PendingRoomMessage = RoomMessage & {
  pendingStatus: PendingRoomMessageStatus
  error?: string
}

let pendingRoomMessageCounter = 0

function createPendingRoomMessage(teamRunId: string, input: PostRoomMessageInput): PendingRoomMessage {
  pendingRoomMessageCounter += 1
  return {
    id: `pending-room-message-${Date.now()}-${pendingRoomMessageCounter}`,
    teamRunId,
    senderType: input.senderType ?? 'user',
    senderId: input.senderId ?? null,
    senderInvocationId: input.senderInvocationId ?? null,
    kind: input.kind ?? ((input.mentions?.length ?? 0) > 0 ? 'work_request' : 'chat'),
    content: input.content,
    mentions: input.mentions ?? [],
    workRequestIds: [],
    artifactRefs: input.artifactRefs ?? [],
    attachmentIds: input.attachmentIds ?? [],
    createdAt: new Date().toISOString(),
    pendingStatus: 'sending',
  }
}

function isPendingRoomMessage(message: RoomMessage): message is PendingRoomMessage {
  return 'pendingStatus' in message
}

const attachmentUrlTransform: UrlTransform = (url) => {
  if (url.includes('://')) return url
  if (url.startsWith('/api/')) return url
  if (url.startsWith('/')) {
    return `${API_BASE_URL}/attachments/by-path?path=${encodeURIComponent(url)}`
  }
  return url
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function formatGeneratedAttachmentMarkdown(attachment: Pick<Attachment, 'originalName' | 'mimeType' | 'storagePath'>): string {
  const prefix = attachment.mimeType.startsWith('image/') ? '!' : ''
  return `${prefix}[${attachment.originalName}](${attachment.storagePath})`
}

export function filterGeneratedAttachmentMarkdown(content: string, attachments: Array<Pick<Attachment, 'originalName' | 'mimeType' | 'storagePath'>>): string {
  if (attachments.length === 0) return content

  const generatedLines = new Set(attachments.map(formatGeneratedAttachmentMarkdown))
  return content
    .split('\n')
    .map((line) => {
      const leadingWhitespace = line.match(/^\s*/)?.[0] ?? ''
      const normalizedLine = line.trimStart()
      for (const generatedLine of generatedLines) {
        if (normalizedLine === generatedLine) return null
        if (normalizedLine.startsWith(`${generatedLine} `) || normalizedLine.startsWith(`${generatedLine}\t`)) {
          return `${leadingWhitespace}${normalizedLine.slice(generatedLine.length).trimStart()}`
        }
      }
      return line
    })
    .filter((line): line is string => line != null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function formatTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
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
        'prose prose-sm max-w-none break-words [overflow-wrap:anywhere]',
        'prose-p:my-2 prose-p:first:mt-0 prose-p:last:mb-0 prose-p:leading-6',
        'prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-li:pl-0 prose-li:leading-6 prose-li:marker:text-neutral-400',
        'prose-blockquote:my-2 prose-blockquote:border-l-2 prose-blockquote:border-neutral-300 prose-blockquote:pl-3 prose-blockquote:text-neutral-600',
        'prose-pre:my-3 prose-pre:max-w-full prose-pre:overflow-x-auto prose-pre:rounded-md prose-pre:border prose-pre:border-neutral-800 prose-pre:bg-neutral-950 prose-pre:p-3 prose-pre:text-xs prose-pre:leading-relaxed prose-pre:shadow-inner',
        'prose-code:break-words prose-code:rounded prose-code:bg-neutral-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.9em] prose-code:font-medium prose-code:text-neutral-800',
        'prose-pre:prose-code:bg-transparent prose-pre:prose-code:p-0 prose-pre:prose-code:text-neutral-100',
        'prose-headings:mb-2 prose-headings:mt-3 prose-headings:font-semibold prose-headings:leading-snug',
        'prose-a:text-blue-600 prose-a:underline-offset-2 hover:prose-a:text-blue-700',
        'prose-hr:my-3 prose-hr:border-neutral-200',
        isUser
          ? [
              'text-white prose-strong:text-white prose-headings:text-white prose-blockquote:border-white/30 prose-blockquote:text-neutral-200',
              'prose-code:bg-white/15 prose-code:text-white prose-pre:border-neutral-700 prose-a:text-blue-200 hover:prose-a:text-blue-100 prose-hr:border-white/15',
            ]
          : 'text-neutral-800 prose-strong:text-neutral-900',
      )}
    >
      <Streamdown urlTransform={attachmentUrlTransform} components={streamdownComponents}>
        {content}
      </Streamdown>
    </div>
  )
}

function MessageAttachments({
  hasAttachmentIds,
  attachments,
  isLoading,
  onOpenImage,
}: {
  hasAttachmentIds: boolean
  attachments: Attachment[]
  isLoading: boolean
  onOpenImage: (attachments: Attachment[], index: number) => void
}) {
  if (!hasAttachmentIds) return null
  if (isLoading && attachments.length === 0) {
    return (
      <div className="mt-3 text-xs text-neutral-400">
        Loading attachments...
      </div>
    )
  }
  if (attachments.length === 0) return null

  const imageAttachments = attachments.filter((attachment) => attachment.mimeType.startsWith('image/'))
  const imageIndexById = new Map(imageAttachments.map((attachment, index) => [attachment.id, index]))

  return (
    <div className="mt-3 flex flex-wrap gap-2 text-neutral-700">
      {attachments.map((attachment) => {
        const attachmentUrl = `${API_BASE_URL}${attachment.url}`
        const isImage = attachment.mimeType.startsWith('image/')
        if (isImage) {
          const imageIndex = imageIndexById.get(attachment.id) ?? 0
          return (
            <button
              key={attachment.id}
              type="button"
              onClick={() => onOpenImage(imageAttachments, imageIndex)}
              className="group relative h-24 w-24 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 shadow-sm transition-opacity hover:opacity-90"
              title={attachment.originalName}
            >
              <img
                src={attachmentUrl}
                alt={attachment.originalName}
                className="h-full w-full object-cover"
                loading="lazy"
              />
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-1 text-left text-[10px] text-white">
                {attachment.originalName}
              </span>
            </button>
          )
        }

        return (
          <a
            key={attachment.id}
            href={attachmentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex max-w-[220px] items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-700 shadow-sm hover:bg-neutral-50"
            title={attachment.originalName}
          >
            <FileText size={16} className="shrink-0 text-neutral-400" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{attachment.originalName}</span>
              <span className="text-neutral-400">{formatAttachmentSize(attachment.sizeBytes)}</span>
            </span>
            <ExternalLink size={13} className="shrink-0 text-neutral-400" aria-hidden />
          </a>
        )
      })}
    </div>
  )
}

function RoomMessageBody({
  content,
  attachmentIds,
  isUser,
  tone,
  onOpenImage,
}: {
  content: string
  attachmentIds?: string[] | null
  isUser?: boolean
  tone?: RoomMessageTone
  onOpenImage: (attachments: Attachment[], index: number) => void
}) {
  const ids = useMemo(() => Array.from(new Set(attachmentIds ?? [])), [attachmentIds])
  const { data: attachments = [], isLoading } = useAttachmentMetadata(ids)
  const renderedContent = attachments.length > 0
    ? filterGeneratedAttachmentMarkdown(content, attachments)
    : content

  return (
    <>
      {renderedContent.trim() && (
        <CollapsibleRoomMessageContent
          content={renderedContent}
          isUser={isUser}
          tone={tone}
        />
      )}
      <MessageAttachments
        hasAttachmentIds={ids.length > 0}
        attachments={attachments}
        isLoading={isLoading}
        onOpenImage={onOpenImage}
      />
    </>
  )
}

function AttachmentLightbox({
  images,
  index,
  onClose,
  onSelect,
}: {
  images: Attachment[]
  index: number
  onClose: () => void
  onSelect: (index: number) => void
}) {
  const current = images[index]
  if (!current) return null

  const hasPrevious = index > 0
  const hasNext = index < images.length - 1

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true">
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        aria-label="Close image preview"
      >
        <X size={20} />
      </button>

      {hasPrevious && (
        <button
          type="button"
          onClick={() => onSelect(index - 1)}
          className="absolute left-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
          aria-label="Previous image"
        >
          <ChevronLeft size={24} aria-hidden />
        </button>
      )}

      <div className="flex max-h-full max-w-full flex-col items-center gap-3">
        <img
          src={`${API_BASE_URL}${current.url}`}
          alt={current.originalName}
          className="max-h-[82vh] max-w-[92vw] rounded-lg object-contain"
        />
        <div className="flex items-center gap-3 text-sm text-white">
          <span className="max-w-[70vw] truncate">{current.originalName}</span>
          <a
            href={`${API_BASE_URL}${current.url}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
          >
            <ExternalLink size={13} aria-hidden />
            Open
          </a>
        </div>
      </div>

      {hasNext && (
        <button
          type="button"
          onClick={() => onSelect(index + 1)}
          className="absolute right-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
          aria-label="Next image"
        >
          <ChevronRight size={24} aria-hidden />
        </button>
      )}
    </div>
  )
}

export function buildRoomMessageSubmitInput({
  draft,
  attachmentMarkdown,
  attachmentIds,
  mentions,
}: {
  draft: string
  attachmentMarkdown: string
  attachmentIds: string[]
  mentions: StructuredMention[]
}): PostRoomMessageInput | null {
  const content = draft.trim()
  const messageContent = [content, attachmentMarkdown].filter(Boolean).join('\n\n')
  if (!messageContent) return null

  return {
    content: messageContent,
    mentions,
    senderType: 'user',
    ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
  }
}

type RoomMessageTone = 'agent' | 'user' | 'system'

function CollapsibleRoomMessageContent({
  content,
  isUser,
  tone = isUser ? 'user' : 'agent',
}: {
  content: string
  isUser?: boolean
  tone?: RoomMessageTone
}) {
  const { t } = useI18n()
  const contentId = useId()
  const contentRef = useRef<HTMLDivElement>(null)
  const [expandedState, setExpandedState] = useState<{ content: string; expanded: boolean } | null>(null)
  const [isCollapsible, setIsCollapsible] = useState(false)
  const isExpanded = expandedState?.content === content && expandedState.expanded

  const measureContent = useCallback(() => {
    const element = contentRef.current
    if (!element) return
    setIsCollapsible(isRoomMessageContentOverflowing(element.scrollHeight))
  }, [])

  useLayoutEffect(() => {
    measureContent()

    const element = contentRef.current
    if (!element) return

    const animationFrame = window.requestAnimationFrame(measureContent)
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measureContent)
    resizeObserver?.observe(element)
    window.addEventListener('resize', measureContent)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', measureContent)
    }
  }, [content, measureContent])

  const isCollapsed = isCollapsible && !isExpanded

  return (
    <div className="relative">
      <div
        id={contentId}
        ref={contentRef}
        onLoadCapture={measureContent}
        className={cn(
          'relative transition-[max-height] duration-200 ease-out',
          isCollapsed ? 'overflow-hidden' : '',
        )}
        style={isCollapsed ? { maxHeight: ROOM_MESSAGE_COLLAPSED_MAX_HEIGHT } : undefined}
      >
        <RoomMessageMarkdown content={content} isUser={isUser} />
        {isCollapsed && (
          <div
            className={cn(
              'pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent',
              tone === 'system' ? 'to-amber-50' : tone === 'user' ? 'to-neutral-900' : 'to-neutral-100',
            )}
          />
        )}
      </div>

      {isCollapsible && (
        <button
          type="button"
          aria-expanded={isExpanded}
          aria-controls={contentId}
          aria-label={isExpanded ? t('Collapse message') : t('Expand full message')}
          onClick={() => setExpandedState({ content, expanded: !isExpanded })}
          className={cn(
            'mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300',
            tone === 'system'
              ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
              : tone === 'user'
                ? 'bg-white/10 text-neutral-100 hover:bg-white/15 hover:text-white'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900',
          )}
        >
          {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          <span>{isExpanded ? t('Collapse message') : t('Expand full message')}</span>
        </button>
      )}
    </div>
  )
}

function RoomMessageRow({
  senderName,
  avatar,
  createdAt,
  isUser,
  isSystem,
  children,
  headerAddon,
  bubbleClassName,
  isPending,
}: {
  senderName: string
  avatar?: string | null
  createdAt?: string
  isUser?: boolean
  isSystem?: boolean
  children: ReactNode
  headerAddon?: ReactNode
  bubbleClassName?: string
  isPending?: boolean
}) {
  if (isSystem) {
    return (
      <div className="flex justify-center">
        <div className="max-w-[min(100%,42rem)] rounded-lg border border-amber-200/80 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow-sm">
          {children}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'group flex items-start gap-3',
        isUser ? 'justify-end pl-8 sm:pl-14' : 'justify-start pr-8 sm:pr-14',
      )}
    >
      {!isUser && (
        <MemberAvatar
          name={senderName}
          avatar={avatar ?? null}
          className="mt-0.5 h-8 w-8 text-[11px]"
        />
      )}
      <div className={cn('flex min-w-0 max-w-[min(86%,46rem)] flex-col', isUser ? 'items-end' : 'items-start')}>
        <div
          className={cn(
            'mb-1.5 flex max-w-full items-center gap-1.5 px-0.5 text-[11px] text-neutral-500',
            isUser ? 'justify-end' : 'justify-start',
          )}
        >
          <span className="truncate font-semibold text-neutral-700">{senderName}</span>
          <span className="h-1 w-1 rounded-full bg-neutral-300" aria-hidden />
          <Clock3 size={11} className="text-neutral-400" />
          <span className="shrink-0">{formatTime(createdAt)}</span>
          {headerAddon}
        </div>
        <div
          className={cn(
            'max-w-full rounded-lg px-3.5 py-3 text-sm leading-6 transition-colors',
            isUser
              ? 'rounded-tr-[2px] border border-neutral-900 bg-neutral-900 text-white shadow-sm'
              : 'rounded-tl-[2px] bg-neutral-100 text-neutral-900 shadow-sm',
            bubbleClassName,
            isPending ? 'opacity-70' : '',
          )}
        >
          {children}
        </div>
      </div>
      {isUser && (
        <MemberAvatar
          name={senderName}
          avatar={null}
          className="mt-0.5 h-8 w-8 border-neutral-300 bg-neutral-900 text-white text-[11px]"
        />
      )}
    </div>
  )
}

function RoomChatMessage({
  message,
  senderName,
  senderMember,
  displayContent,
  onOpenImage,
}: {
  message: RoomMessage
  senderName: string
  senderMember?: TeamMember | null
  displayContent: string
  onOpenImage: (attachments: Attachment[], index: number) => void
}) {
  const { t } = useI18n()
  const isUser = message.senderType === 'user'
  const isSystem = message.senderType === 'system'
  const pendingStatus = isPendingRoomMessage(message) ? message.pendingStatus : null
  const mentions = message.mentions ?? []
  const workRequestCount = message.workRequestIds?.length ?? 0
  const headerAddon = (
    <>
      {!isSystem && workRequestCount > 0 && mentions.length === 0 && (
        <span className="ml-0.5 shrink-0 rounded-full bg-neutral-900/8 px-1.5 py-0.5 text-[10px] font-medium leading-none text-neutral-600">
          {t('Work requests')}: {workRequestCount}
        </span>
      )}
      {pendingStatus === 'sending' && (
        <span className="ml-0.5 shrink-0 rounded-full bg-neutral-900/8 px-1.5 py-0.5 text-[10px] font-medium leading-none text-neutral-500">
          {t('发送中...')}
        </span>
      )}
      {pendingStatus === 'failed' && (
        <span className="ml-0.5 shrink-0 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-red-600">
          {t('发送失败')}
        </span>
      )}
    </>
  )

  return (
    <RoomMessageRow
      senderName={senderName}
      avatar={senderMember?.avatar ?? null}
      createdAt={message.createdAt}
      isUser={isUser}
      isSystem={isSystem}
      headerAddon={headerAddon}
      bubbleClassName={isUser && pendingStatus === 'failed' ? 'border-red-200 bg-red-50 text-red-900' : undefined}
      isPending={pendingStatus === 'sending'}
    >
      <RoomMessageBody
        content={displayContent}
        attachmentIds={message.attachmentIds}
        isUser={isUser && pendingStatus !== 'failed'}
        tone={isSystem ? 'system' : undefined}
        onOpenImage={onOpenImage}
      />
    </RoomMessageRow>
  )
}

function PendingApprovalBubble({
  request,
  member,
  onApprove,
  onReject,
  isActionPending,
  isApprovePending,
  isRejectPending,
}: {
  request: WorkRequest
  member?: TeamMember | null
  onApprove: () => void
  onReject: () => void
  isActionPending: boolean
  isApprovePending: boolean
  isRejectPending: boolean
}) {
  const { t } = useI18n()

  return (
    <RoomMessageRow
      senderName={member?.name ?? t('Agent')}
      avatar={member?.avatar ?? null}
      createdAt={request.createdAt}
      bubbleClassName="border border-amber-200/80 bg-amber-50/80"
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
            <Clock3 size={11} />
            {t('Pending approval')}
          </span>
          <span className="text-[11px] text-neutral-500">{t('Requester')}: {t(request.requesterType === 'user' ? 'User' : request.requesterType === 'system' ? 'System' : 'Agent')}</span>
        </div>

        <div className="text-sm leading-6 text-neutral-800 [overflow-wrap:anywhere]">
          {request.instruction}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={isActionPending}
            className="border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800"
            onClick={onApprove}
          >
            <Check size={12} />
            <span>{isApprovePending ? t('Approving') : t('Approve')}</span>
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={isActionPending}
            onClick={onReject}
          >
            <X size={12} />
            <span>{isRejectPending ? t('Rejecting') : t('Reject')}</span>
          </Button>
        </div>
      </div>
    </RoomMessageRow>
  )
}

export function RoomTimeline({
  teamRun,
  messages,
  readOnly,
  readOnlyMessage,
  onSendMessage,
  onViewInvocationSession,
  compactComposer,
}: RoomTimelineProps) {
  const { t } = useI18n()
  const approveWorkRequest = useApproveWorkRequest(teamRun.id)
  const rejectWorkRequest = useRejectWorkRequest(teamRun.id)
  const stopMemberWork = useStopMemberWork(teamRun.id)
  const [draft, setDraft] = useState('')
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false)
  const [inlineMention, setInlineMention] = useState<{ start: number; end: number; query: string } | null>(null)
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0)
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [pendingMessages, setPendingMessages] = useState<PendingRoomMessage[]>([])
  const [stopPromptInvocationId, setStopPromptInvocationId] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const {
    files: attachmentFiles,
    addFiles,
    removeFile,
    clear: clearAttachments,
    restoreFiles: restoreAttachments,
    buildMarkdownLinks,
    getDoneAttachments,
    isUploading,
  } = useAttachments()
  const hasSendableAttachments = attachmentFiles.some((file) => file.status === 'done' && file.attachment)
  const [lightboxState, setLightboxState] = useState<{ images: Attachment[]; index: number } | null>(null)

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
    const confirmedIds = new Set(messages.map((message) => message.id))
    const visiblePendingMessages = pendingMessages.filter((message) => !confirmedIds.has(message.id))

    return [...messages, ...visiblePendingMessages].sort((a, b) => {
      const aTime = Date.parse(a.createdAt ?? '')
      const bTime = Date.parse(b.createdAt ?? '')
      return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime)
    })
  }, [messages, pendingMessages])

  const workRequestById = useMemo(() => {
    return new Map((teamRun.workRequests ?? []).map((request) => [request.id, request]))
  }, [teamRun.workRequests])

  const timelineItems = useMemo(
    () => buildRoomTimelineItems(messageList, teamRun.workRequests ?? [], teamRun.invocations ?? []),
    [messageList, teamRun.invocations, teamRun.workRequests],
  )

  const activeInvocations = useMemo(
    () => (teamRun.invocations ?? []).filter((invocation) => ACTIVE_ROOM_INVOCATION_STATUSES.has(invocation.status)),
    [teamRun.invocations],
  )

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
    setSelectedMemberIds((current) => addSelectedMemberId(current, member.id))

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

  const handleRemoveSelectedMention = useCallback((memberId: string) => {
    setSelectedMemberIds((current) => removeSelectedMemberId(current, memberId))
  }, [])

  const handleDraftChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value
    setDraft(value)
    setSubmitError(null)
    const element = event.target
    element.style.height = 'auto'
    element.style.height = `${Math.max(compactComposer ? 40 : 72, Math.min(element.scrollHeight, compactComposer ? 140 : 240))}px`
    setMentionPickerOpen(false)
    syncInlineMention(value, element.selectionStart)
  }, [compactComposer, syncInlineMention])

  const handleFileInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files
    if (fileList && fileList.length > 0) {
      void addFiles(Array.from(fileList))
      setSubmitError(null)
    }
    event.target.value = ''
  }, [addFiles])

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = []
    for (const item of event.clipboardData.items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      event.preventDefault()
      void addFiles(files)
      setSubmitError(null)
    }
  }, [addFiles])

  const handleSubmit = useCallback(async () => {
    if (readOnly || isSubmitting || isUploading) return
    const attachmentMarkdown = buildMarkdownLinks()
    const attachmentIds = getDoneAttachments().map((attachment) => attachment.id)
    const mentions = buildStructuredMentionsFromSelectedMembers(selectedMemberIds, teamRun.members ?? [])
    const input = buildRoomMessageSubmitInput({
      draft,
      attachmentMarkdown,
      attachmentIds,
      mentions,
    })
    if (!input || (!draft.trim() && !hasSendableAttachments)) return

    const pendingMessage = createPendingRoomMessage(teamRun.id, input)
    const previousDraft = draft
    const previousSelectedMemberIds = selectedMemberIds
    const previousAttachmentFiles = attachmentFiles

    setPendingMessages((current) => [...current, pendingMessage])
    setDraft('')
    setSelectedMemberIds([])
    setMentionPickerOpen(false)
    setInlineMention(null)
    clearAttachments()
    if (textareaRef.current) {
      textareaRef.current.style.height = compactComposer ? '40px' : '72px'
    }
    requestAnimationFrame(() => scrollToBottom())

    setIsSubmitting(true)
    setSubmitError(null)
    try {
      const savedMessage = await onSendMessage(input)
      setPendingMessages((current) => current.filter((message) => message.id !== pendingMessage.id))
      if (savedMessage && typeof savedMessage === 'object' && 'id' in savedMessage) {
        requestAnimationFrame(() => scrollToBottom())
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to send room message'
      setPendingMessages((current) => current.map((item) => item.id === pendingMessage.id
        ? { ...item, pendingStatus: 'failed', error: message }
        : item))
      setDraft((current) => current.length === 0 ? previousDraft : current)
      setSelectedMemberIds((current) => current.length === 0 ? previousSelectedMemberIds : current)
      restoreAttachments(previousAttachmentFiles)
      setSubmitError(message)
      requestAnimationFrame(() => scrollToBottom())
    } finally {
      setIsSubmitting(false)
    }
  }, [attachmentFiles, buildMarkdownLinks, clearAttachments, compactComposer, draft, getDoneAttachments, hasSendableAttachments, isSubmitting, isUploading, onSendMessage, readOnly, restoreAttachments, scrollToBottom, selectedMemberIds, teamRun.id, teamRun.members])

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
    setPendingMessages([])
    clearAttachments()
    setStopPromptInvocationId(null)
    if (textareaRef.current) {
      textareaRef.current.style.height = compactComposer ? '40px' : '72px'
    }
  }, [clearAttachments, compactComposer, teamRun.id])

  const pendingApprovalError =
    approveWorkRequest.isError
      ? approveWorkRequest.error
      : rejectWorkRequest.isError
        ? rejectWorkRequest.error
        : null

  const isPendingApprovalActionPending =
    approveWorkRequest.isPending
    || rejectWorkRequest.isPending

  const handleStopMember = useCallback((memberId: string, cancelQueued: boolean) => {
    stopMemberWork.mutate(
      { memberId, cancelQueued },
      { onSuccess: () => setStopPromptInvocationId(null) },
    )
  }, [stopMemberWork])

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {lightboxState && (
        <AttachmentLightbox
          images={lightboxState.images}
          index={lightboxState.index}
          onClose={() => setLightboxState(null)}
          onSelect={(index) => setLightboxState((current) => current ? { ...current, index } : current)}
        />
      )}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          className={cn(
            'h-full overflow-y-auto scrollbar-app-thin bg-white',
            compactComposer ? 'px-3 py-3' : 'px-4 py-4',
          )}
        >
          <div ref={contentRef} className={cn(compactComposer ? 'space-y-2.5' : 'space-y-3')}>
            {timelineItems.length === 0 ? (
              <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-200 bg-white text-neutral-500">
                <Users size={24} className="text-neutral-400" />
                <span className="text-sm">{t('No room messages yet')}</span>
              </div>
            ) : (
              timelineItems.map((item) => {
                if (item.kind === 'pendingApproval') {
                  const request = item.request
                  const member = memberById.get(request.targetMemberId)
                  const isApprovePending = approveWorkRequest.isPending && approveWorkRequest.variables === request.id
                  const isRejectPending = rejectWorkRequest.isPending && rejectWorkRequest.variables === request.id

                  return (
                    <PendingApprovalBubble
                      key={item.key}
                      request={request}
                      member={member}
                      onApprove={() => approveWorkRequest.mutate(request.id)}
                      onReject={() => rejectWorkRequest.mutate(request.id)}
                      isActionPending={isPendingApprovalActionPending}
                      isApprovePending={isApprovePending}
                      isRejectPending={isRejectPending}
                    />
                  )
                }

                const message = item.message
                const senderMember = resolveSenderMember(message, memberById, invocationById)
                const senderName =
                  message.senderType === 'user'
                    ? t('你')
                    : message.senderType === 'system'
                      ? t('System')
                      : senderMember?.name ?? t('Agent')
                const displayContent = getDisplayContent(message, memberById)

                return (
                  <RoomChatMessage
                    key={item.key}
                    message={message}
                    senderName={senderName}
                    senderMember={senderMember}
                    displayContent={displayContent}
                    onOpenImage={(images, index) => setLightboxState({ images, index })}
                  />
                )
              })
            )}

            {pendingApprovalError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {getErrorMessage(pendingApprovalError, t('Failed to update work request'))}
              </div>
            )}
            {stopMemberWork.isError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {getErrorMessage(stopMemberWork.error, t('Failed to stop member work'))}
              </div>
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

      <div className={cn(
        'shrink-0 border-t border-transparent bg-white',
        compactComposer ? 'px-3 pb-2 pt-1.5' : 'px-6 pb-6 pt-2',
      )}>
        <ActiveWorkList
          invocations={activeInvocations}
          memberById={memberById}
          workRequestById={workRequestById}
          onViewInvocationSession={onViewInvocationSession}
          onStopMember={handleStopMember}
          isStopPending={stopMemberWork.isPending}
          stoppingMemberId={stopMemberWork.variables?.memberId ?? null}
          stopPromptInvocationId={stopPromptInvocationId}
          onToggleStopConfirm={(invocationId) => setStopPromptInvocationId((current) => current === invocationId ? null : invocationId)}
        />
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
                        <MemberAvatar
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
                            {[member.providerId, member.id.slice(0, 8)]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        </div>
                        <AtSign size={15} className="text-neutral-400" />
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {selectedMembers.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-100 px-3 py-2">
                {selectedMembers.map((member) => (
                  <span
                    key={member.id}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs text-neutral-700"
                  >
                    <span className="truncate font-medium">@{member.name}</span>
                    <span className="shrink-0 text-[10px] text-neutral-400">{member.id.slice(0, 8)}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveSelectedMention(member.id)}
                      className="shrink-0 rounded-full p-0.5 text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700"
                      title={t('Remove mention')}
                      aria-label={`${t('Remove mention')} ${member.name}`}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <AttachmentPreview files={attachmentFiles} onRemove={removeFile} />

            <textarea
              ref={textareaRef}
              value={draft}
              rows={compactComposer ? 1 : undefined}
              onChange={handleDraftChange}
              onKeyDown={handleDraftKeyDown}
              onPaste={handlePaste}
              onClick={(event) => syncInlineMention(draft, event.currentTarget.selectionStart)}
              onSelect={(event) => syncInlineMention(draft, event.currentTarget.selectionStart)}
              placeholder={t('Message the team room...')}
              className={cn(
                'w-full resize-none border-none bg-transparent text-neutral-900 placeholder-neutral-400 focus:outline-none',
                compactComposer
                  ? 'px-3 pb-1 pt-2.5 text-[15px] leading-5'
                  : 'px-4 pb-2 pt-4 text-sm leading-relaxed',
              )}
              style={compactComposer ? { minHeight: 40, maxHeight: 140 } : { minHeight: 60, maxHeight: 220 }}
            />

            <div className={cn('flex items-center justify-between', compactComposer ? 'px-2 pb-1.5 pt-0.5' : 'px-2 pb-2 pt-1')}>
              <div className="flex items-center gap-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileInputChange}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title={t('Upload file')}
                  aria-label={t('Upload file')}
                  className="rounded-lg p-2 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600"
                >
                  <Paperclip size={18} />
                </button>
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
                    'rounded-lg transition-colors',
                    compactComposer ? 'p-1.5' : 'p-2',
                    mentionPickerOpen
                      ? 'bg-neutral-100 text-neutral-700'
                      : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600',
                    selectedMembers.length === 0 && (teamRun.members ?? []).length === 0
                      ? 'cursor-not-allowed opacity-50'
                      : '',
                  )}
                >
                  <AtSign size={compactComposer ? 15 : 18} />
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
                disabled={readOnly || isSubmitting || isUploading || (!draft.trim() && !hasSendableAttachments)}
                title={isUploading ? t('Uploading...') : isSubmitting ? t('发送中...') : t('发送')}
                aria-label={isUploading ? t('Uploading...') : isSubmitting ? t('发送中...') : t('发送')}
                className={cn(
                  'rounded-lg transition-all duration-200',
                  compactComposer ? 'p-1.5' : 'p-2',
                  (draft.trim() || hasSendableAttachments) && !readOnly && !isSubmitting && !isUploading
                    ? 'bg-neutral-900 text-white shadow-md hover:bg-black'
                    : 'cursor-not-allowed bg-transparent text-neutral-300',
                  isSubmitting || isUploading ? 'opacity-70' : '',
                )}
              >
                <ArrowUp size={compactComposer ? 15 : 18} />
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
