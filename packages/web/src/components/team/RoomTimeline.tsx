import type { MessageDelivery } from '@agent-tower/shared'
import { MessageDeliveryFeedback } from '@/components/agent/MessageDeliveryStatus'
import { TeamRoomDeliveryStatus } from './TeamRoomDeliveryStatus'
import { pendingTeamRoomSubmissions, forgetTeamRoomSubmission } from '@/hooks/team-room-submission'
import { useMessageDeliveries } from '@/hooks/use-message-deliveries'
import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useState, useRef } from 'react'
import type { ChangeEvent, KeyboardEvent, ReactNode, RefObject } from 'react'
import { buildRoomMessageSubmitInput, filterGeneratedAttachmentMarkdown } from './room-message-content'
import { VirtualRoomMessageList } from './VirtualRoomMessageList'
import { useStickToBottom } from 'use-stick-to-bottom'
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  AtSign,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  ExternalLink,
  FileText,
  LockKeyhole,
  Paperclip,
  Users,
  X,
} from 'lucide-react'
import { Streamdown } from 'streamdown'
import type { AgentInvocation, Attachment, Provider, RoomMessage, StructuredMention, TeamMember, TeamRun, WorkRequest, TeamRunTranslationOverlay, TeamRunTranslationOverlaySummary } from '@agent-tower/shared'
import type { PostRoomMessageInput } from '@/hooks/use-team-run'
import { useAttachmentMetadata, useAttachments } from '@/hooks/use-attachments'
import { AttachmentPreview } from '@/components/ui/AttachmentPreview'
import {
  useApproveWorkRequest,
  useRejectWorkRequest,
  useRoomMessageDetail,
  useStopMemberWork,
} from '@/hooks/use-team-run'
import { useProviders } from '@/hooks/use-providers'
import { useTeamRunTranslations, type RoomTranslations } from '@/hooks/use-team-run-translations'
import { useTranslationSettings } from '@/hooks/use-translation-settings'
import { TranslationComparison, TranslationReveal, TranslationState } from '@/components/agent/TranslationComparison'
import { AgentLogo } from '@/components/agent/AgentLogo'
import { Button } from '@/components/ui/button'
import { MemberAvatar } from './MemberAvatar'
import { cn } from '@/lib/utils'
import { createUuid } from '@/lib/uuid'
import { useI18n } from '@/lib/i18n'
import { getApiBaseUrl } from '@/lib/api-base-url'
import {
  ROOM_MESSAGE_COLLAPSED_MAX_HEIGHT,
  isRoomMessageContentOverflowing,
} from './room-message-collapse'
import {
  addSelectedMemberId,
  buildStructuredMentionsFromSelectedMembers,
  removeSelectedMemberId,
} from './room-mentions'
import { ACTIVE_ROOM_INVOCATION_STATUSES, buildRoomTimelineItems, type RoomTimelineItem } from './room-timeline-items'
import { ActiveWorkList } from './ActiveWorkList'
import {
  createMessageStreamdownComponents,
  streamdownMermaidControls,
  type OpenPreviewUrlHandler,
  type OpenVisualizationHandler,
} from '@/lib/streamdown-components'
import { prepareMessageMarkdown } from '@/lib/message-intent'
import { useStreamdownMermaidPlugins } from '@/lib/streamdown-mermaid'
import 'streamdown/styles.css'

interface RoomTimelineProps {
  teamRun: TeamRun
  messages: RoomMessage[]
  readOnly?: boolean
  readOnlyMessage?: string
  onSendMessage: (input: PostRoomMessageInput) => Promise<unknown>
  onViewInvocationSession?: (sessionId: string) => void
  changeSummaryBar?: ReactNode
  compactComposer?: boolean
  /** Constrain content width and center horizontally (e.g. when side panel is hidden) */
  centered?: boolean
  workingDir?: string
  onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void
  onOpenPreviewUrl?: (url: string, workspaceId?: string) => void
  onOpenVisualization?: (sessionId: string, file: string, workspaceId?: string) => void
}

const API_BASE_URL = getApiBaseUrl()
const INLINE_PREVIEW_MAX_LENGTH = 240

type PendingRoomMessageStatus = 'sending' | 'failed'
type PendingRoomMessage = RoomMessage & {
  pendingStatus: PendingRoomMessageStatus
  error?: string
  submissionInput: PostRoomMessageInput
}

function createPendingRoomMessage(teamRunId: string, input: PostRoomMessageInput): PendingRoomMessage {
  return {
    id: input.clientSubmissionId ?? createUuid(),
    submissionInput: input,
    teamRunId,
    senderType: input.senderType ?? 'user',
    senderId: input.senderId ?? null,
    senderInvocationId: input.senderInvocationId ?? null,
    kind: input.kind ?? ((input.mentions?.length ?? 0) > 0 ? 'work_request' : 'chat'),
    visibility: 'PUBLIC',
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

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
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

function previewText(value?: string | null, maxLength = INLINE_PREVIEW_MAX_LENGTH) {
  const compact = (value ?? '').replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, maxLength - 3).trimEnd()}...`
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

function isActiveTeamMember(member: TeamMember) {
  return member.membershipStatus !== 'REMOVED'
}

function getMentionLabel(mention: StructuredMention, memberById: Map<string, TeamMember>) {
  return mention.label ?? memberById.get(mention.memberId)?.name ?? mention.memberId
}

function getPrivateRecipientLabels(message: RoomMessage, memberById: Map<string, TeamMember>) {
  return (message.recipientMemberIds ?? [])
    .map((memberId) => memberById.get(memberId)?.name ?? memberId)
}

function getDisplayContent(message: RoomMessage, memberById: Map<string, TeamMember>) {
  const mentions = message.mentions ?? []
  const baseContent = message.contentPreview ?? message.content
  if (mentions.length === 0) return baseContent

  const missingLabels = mentions
    .map((mention) => getMentionLabel(mention, memberById))
    .filter((label) => label && !baseContent.includes(`@${label}`))

  if (missingLabels.length === 0) return baseContent

  const suffix = missingLabels.map((label) => `@${label}`).join(' ')
  return baseContent.trimEnd() ? `${baseContent.trimEnd()} ${suffix}` : suffix
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
  workingDir,
  onOpenWorkspaceFile,
  onOpenPreviewUrl,
  onOpenVisualization,
  downloadSessionId,
}: {
  content: string
  isUser?: boolean
  workingDir?: string
  onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void
  onOpenPreviewUrl?: OpenPreviewUrlHandler
  onOpenVisualization?: OpenVisualizationHandler
  downloadSessionId?: string
}) {
  const markdown = useMemo(
    () => onOpenVisualization || downloadSessionId ? prepareMessageMarkdown(content) : content,
    [content, downloadSessionId, onOpenVisualization],
  )
  const mermaidPlugins = useStreamdownMermaidPlugins(markdown)
  const components = useMemo(
    () => createMessageStreamdownComponents({ workingDir, onOpenWorkspaceFile, onOpenPreviewUrl, onOpenVisualization, downloadSessionId }),
    [downloadSessionId, onOpenPreviewUrl, onOpenVisualization, onOpenWorkspaceFile, workingDir],
  )

  return (
    <div
      className={cn(
        'team-room-message-markdown prose prose-sm max-w-none break-words [overflow-wrap:anywhere]',
        'prose-p:my-2 prose-p:first:mt-0 prose-p:last:mb-0 prose-p:leading-6',
        'prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-li:pl-0 prose-li:leading-6 prose-li:marker:text-muted-foreground',
        'prose-blockquote:my-2 prose-blockquote:border-l-2 prose-blockquote:border-border prose-blockquote:pl-3 prose-blockquote:text-foreground/70',
        'prose-pre:my-3 prose-pre:max-w-full prose-pre:overflow-x-auto prose-pre:rounded-md prose-pre:border prose-pre:border-border/60 prose-pre:bg-foreground/[0.025] prose-pre:p-3 prose-pre:text-xs prose-pre:leading-relaxed',
        'prose-code:break-words prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.9em] prose-code:font-medium prose-code:text-foreground',
        'prose-pre:prose-code:bg-transparent prose-pre:prose-code:p-0 prose-pre:prose-code:text-foreground',
        'prose-headings:mb-2 prose-headings:mt-3 prose-headings:font-semibold prose-headings:leading-snug',
        'prose-hr:my-3 prose-hr:border-border',
        'text-foreground prose-strong:text-foreground',
      )}
    >
      <Streamdown
        components={components}
        plugins={mermaidPlugins}
        controls={mermaidPlugins ? streamdownMermaidControls : undefined}
      >
        {markdown}
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
      <div className="mt-3 text-xs text-muted-foreground">
        Loading attachments...
      </div>
    )
  }
  if (attachments.length === 0) return null

  const imageAttachments = attachments.filter((attachment) => attachment.mimeType.startsWith('image/'))
  const imageIndexById = new Map(imageAttachments.map((attachment, index) => [attachment.id, index]))

  return (
    <div className="mt-3 flex flex-wrap gap-2 text-foreground/80">
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
              className="group relative h-24 w-24 overflow-hidden rounded-lg border border-border bg-muted/50 shadow-raised transition-opacity hover:opacity-90"
              title={attachment.originalName}
            >
              <img
                src={attachmentUrl}
                alt={attachment.originalName}
                className="h-full w-full object-cover"
                loading="lazy"
              />
              <span className="absolute inset-x-0 bottom-0 truncate bg-inverse/60 px-1.5 py-1 text-left text-[11px] text-inverse-foreground">
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
            className="flex max-w-[220px] items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground/80 shadow-raised hover:bg-accent"
            title={attachment.originalName}
          >
            <FileText size={16} className="shrink-0 text-muted-foreground/70" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{attachment.originalName}</span>
              <span className="text-muted-foreground">{formatAttachmentSize(attachment.sizeBytes)}</span>
            </span>
            <ExternalLink size={13} className="shrink-0 text-muted-foreground/70" aria-hidden />
          </a>
        )
      })}
    </div>
  )
}

function RoomMessageBody({
  message,
  content,
  attachmentIds,
  isUser,
  tone,
  onOpenImage,
  workingDir,
  onOpenWorkspaceFile,
  onOpenPreviewUrl,
  onOpenVisualization,
  downloadSessionId,
  textVersion,
}: {
  message: RoomMessage
  content: string
  attachmentIds?: string[] | null
  isUser?: boolean
  tone?: RoomMessageTone
  onOpenImage: (attachments: Attachment[], index: number) => void
  workingDir?: string
  onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void
  onOpenPreviewUrl?: OpenPreviewUrlHandler
  onOpenVisualization?: OpenVisualizationHandler
  downloadSessionId?: string
  textVersion?: RoomTextVersion
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
          message={message}
          content={renderedContent}
          attachments={attachments}
          isUser={isUser}
          tone={tone}
          workingDir={workingDir}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          onOpenPreviewUrl={onOpenPreviewUrl}
          onOpenVisualization={onOpenVisualization}
          downloadSessionId={downloadSessionId}
          textVersion={textVersion}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-inverse/90 p-4" role="dialog" aria-modal="true">
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-inverse-foreground/10 p-2 text-inverse-foreground transition-colors hover:bg-inverse-foreground/20"
        aria-label="Close image preview"
      >
        <X size={20} />
      </button>

      {hasPrevious && (
        <button
          type="button"
          onClick={() => onSelect(index - 1)}
          className="absolute left-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-inverse-foreground/10 text-inverse-foreground transition-colors hover:bg-inverse-foreground/20"
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
        <div className="flex items-center gap-3 text-sm text-inverse-foreground">
          <span className="max-w-[70vw] truncate">{current.originalName}</span>
          <a
            href={`${API_BASE_URL}${current.url}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md bg-inverse-foreground/10 px-2 py-1 text-xs hover:bg-inverse-foreground/20"
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
          className="absolute right-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-inverse-foreground/10 text-inverse-foreground transition-colors hover:bg-inverse-foreground/20"
          aria-label="Next image"
        >
          <ChevronRight size={24} aria-hidden />
        </button>
      )}
    </div>
  )
}

type ExpandedMessageState = { messageId: string; content: string; expanded: boolean }
const ExpandedMessagesContext = createContext<Map<string, ExpandedMessageState> | null>(null)

type RoomMessageTone = 'agent' | 'user' | 'system'
type RoomTextVersion = { kind: 'translated'; truncated: boolean; full?: string; loading: boolean; load: () => Promise<string> }

function CollapsibleRoomMessageContent({
  message,
  content,
  attachments,
  isUser,
  tone = isUser ? 'user' : 'agent',
  workingDir,
  onOpenWorkspaceFile,
  onOpenPreviewUrl,
  onOpenVisualization,
  downloadSessionId,
  textVersion,
}: {
  message: RoomMessage
  content: string
  attachments: Array<Pick<Attachment, 'originalName' | 'mimeType' | 'storagePath'>>
  isUser?: boolean
  tone?: RoomMessageTone
  workingDir?: string
  onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void
  onOpenPreviewUrl?: OpenPreviewUrlHandler
  onOpenVisualization?: OpenVisualizationHandler
  downloadSessionId?: string
  textVersion?: RoomTextVersion
}) {
  const { t } = useI18n()
  const contentId = useId()
  const contentRef = useRef<HTMLDivElement>(null)
  const expandedMessages = useContext(ExpandedMessagesContext)
  const [expandedState, setLocalExpandedState] = useState(() => expandedMessages?.get(message.id) ?? null)
  const setExpandedState = useCallback((state: ExpandedMessageState) => {
    if (state.expanded) expandedMessages?.set(message.id, state)
    else expandedMessages?.delete(message.id)
    setLocalExpandedState(state)
  }, [expandedMessages, message.id])
  const [isCollapsible, setIsCollapsible] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const detailQuery = useRoomMessageDetail(message.teamRunId, message.id, false)
  const detailContent = textVersion ? textVersion.full : detailQuery.data?.content
  const filteredDetailContent = detailContent
    ? filterGeneratedAttachmentMarkdown(detailContent, attachments)
    : undefined
  const hasFullContent = Boolean(filteredDetailContent && filteredDetailContent !== content)
  const renderContent = hasFullContent ? filteredDetailContent! : content
  const canLoadFullContent = Boolean((textVersion ? textVersion.truncated : message.isTruncated) && !isPendingRoomMessage(message))
  const isExpanded = expandedState?.messageId === message.id
    && expandedState.content === renderContent
    && expandedState.expanded

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
  }, [renderContent, measureContent])

  const handleToggle = useCallback(async () => {
    setLoadError(null)
    if (isExpanded) {
      setExpandedState({ messageId: message.id, content: renderContent, expanded: false })
      return
    }

    if (canLoadFullContent && !detailContent) {
      if (textVersion) {
        try {
          const full = await textVersion.load()
          setExpandedState({ messageId: message.id, content: filterGeneratedAttachmentMarkdown(full, attachments), expanded: true })
        } catch { setLoadError(t('Failed to load full message')) }
        return
      }
      const result = await detailQuery.refetch()
      if (result.error) {
        setLoadError(getErrorMessage(result.error, t('Failed to load full message')))
        return
      }
      const nextContent = result.data?.content
        ? filterGeneratedAttachmentMarkdown(result.data.content, attachments)
        : renderContent
      setExpandedState({ messageId: message.id, content: nextContent, expanded: true })
      return
    }

    setExpandedState({ messageId: message.id, content: renderContent, expanded: true })
  }, [attachments, canLoadFullContent, detailContent, detailQuery, isExpanded, message.id, renderContent, setExpandedState, t, textVersion])

  const isCollapsed = (isCollapsible || canLoadFullContent) && !isExpanded
  const showToggle = isCollapsible || canLoadFullContent
  const isLoadingFullContent = textVersion ? textVersion.loading : detailQuery.isFetching

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
        <RoomMessageMarkdown content={renderContent} isUser={isUser} workingDir={workingDir} onOpenWorkspaceFile={onOpenWorkspaceFile} onOpenPreviewUrl={onOpenPreviewUrl} onOpenVisualization={onOpenVisualization} downloadSessionId={downloadSessionId} />
        {isCollapsed && (
          <div
            className={cn(
              'pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent',
              tone === 'system'
                ? 'to-[color-mix(in_oklab,var(--color-warning)_8%,var(--color-background))]'
                : tone === 'user'
                  ? 'to-[color-mix(in_oklab,var(--color-foreground)_8%,var(--color-background))]'
                  : 'to-background',
            )}
          />
        )}
      </div>

      {showToggle && (
        <button
          type="button"
          aria-expanded={isExpanded}
          aria-controls={contentId}
          aria-label={isExpanded ? t('Collapse message') : t('Expand full message')}
          disabled={isLoadingFullContent}
          onClick={() => void handleToggle()}
          className={cn(
            'mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
            tone === 'system'
              ? 'bg-warning/10 text-warning-ink hover:bg-warning/20'
              : tone === 'user'
                ? 'bg-background/70 text-foreground/70 hover:bg-background hover:text-foreground'
                : 'bg-muted text-foreground/70 hover:bg-foreground/10 hover:text-foreground',
            isLoadingFullContent ? 'cursor-wait opacity-70' : '',
          )}
        >
          {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          <span>
            {isLoadingFullContent
              ? t('Loading')
              : isExpanded
                ? t('Collapse message')
                : t('Expand full message')}
          </span>
        </button>
      )}
      {loadError && (
        <div className={cn(
          'mt-1 text-xs',
          'text-destructive-ink',
        )}>
          {loadError}
        </div>
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
  footer,
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
  footer?: ReactNode
  bubbleClassName?: string
  isPending?: boolean
}) {
  if (isSystem) {
    return (
      <div className="flex justify-center">
        <div className="max-w-[min(100%,42rem)] rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-warning-ink shadow-raised">
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
            'mb-1.5 flex max-w-full items-center gap-1.5 px-0.5 text-xs text-muted-foreground',
            isUser ? 'justify-end' : 'justify-start',
          )}
        >
          <span className="truncate font-semibold text-foreground/80">{senderName}</span>
          <span className="h-1 w-1 rounded-full bg-foreground/15" aria-hidden />
          <Clock3 size={11} className="text-muted-foreground/70" />
          <span className="shrink-0">{formatTime(createdAt)}</span>
          {headerAddon}
        </div>
        <div
          className={cn(
            'max-w-full rounded-lg px-3.5 py-3 text-sm leading-6 transition-colors',
            isUser
              ? 'rounded-tr-[4px] bg-foreground/[0.08] text-foreground'
              : 'rounded-tl-[4px] border border-border/70 bg-background text-foreground',
            bubbleClassName,
            isPending ? 'opacity-70' : '',
          )}
        >
          {children}
        </div>
        {footer && <div className="mt-1 max-w-full px-0.5" data-message-feedback>{footer}</div>}
      </div>
      {isUser && (
        <MemberAvatar
          name={senderName}
          avatar={null}
          className="mt-0.5 h-8 w-8 text-[11px]"
        />
      )}
    </div>
  )
}

function ProviderBadge({ provider }: { provider: Provider }) {
  return (
    <span className="ml-0.5 inline-flex max-w-[10rem] shrink items-center gap-1 rounded-full bg-foreground/5 px-1.5 py-0.5 text-xs font-medium leading-none text-muted-foreground">
      <AgentLogo agentType={provider.agentType} className="size-2.5" />
      <span className="truncate">{provider.name}</span>
    </span>
  )
}

function RoomTranslationBody({ overlay, translations, enabled, body }: {
  overlay: TeamRunTranslationOverlaySummary
  translations: RoomTranslations
  enabled: boolean
  body: Parameters<typeof RoomMessageBody>[0]
}) {
  const { t } = useI18n()
  const [full, setFull] = useState<TeamRunTranslationOverlay | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<Promise<TeamRunTranslationOverlay> | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const valid = () => alive.current && translations.isCurrent(overlay)
  const load = async () => {
    if (!valid()) throw new DOMException('Aborted', 'AbortError')
    if (full) return full
    if (pending.current) return pending.current
    setLoading(true); setError(null)
    pending.current = translations.loadFull(overlay).then(result => {
      if (!valid()) throw new DOMException('Aborted', 'AbortError')
      // Only complete bytes can be compared. The two preview lengths differ.
      if (!body.message.isTruncated && body.message.contentMode === 'full' && body.message.content !== result.originalText) throw new Error('Message changed')
      setFull(result)
      return result
    }).catch(cause => {
      if (valid()) setError(t('Failed to load full message'))
      throw cause
    }).finally(() => { pending.current = null; if (alive.current) setLoading(false) })
    return pending.current
  }
  const translated = overlay.state === 'SUCCESS' && overlay.translatedTextPreview !== null
  const original = full?.originalText ?? overlay.originalTextPreview
  const translatedText = full?.translatedText ?? overlay.translatedTextPreview ?? ''
  const originalText = async () => overlay.originalTextTruncated ? (await load()).originalText : original
  const displayedText = async () => translated
    ? overlay.translatedTextTruncated ? (await load()).translatedText ?? '' : translatedText
    : originalText()
  return <div className={`relative ${overlay.state === 'NOT_REQUIRED' ? '' : 'pr-8'}`}>
      <RoomMessageBody {...body} content={translated ? translatedText : body.content}
        textVersion={translated ? { kind: 'translated', truncated: overlay.translatedTextTruncated, full: full?.translatedText ?? undefined, loading, load: displayedText } : undefined} />
    {overlay.state !== 'NOT_REQUIRED' && <div className="absolute bottom-0 right-0">
      <TranslationComparison original={original} getOriginal={originalText} canCopy={valid}
        onOpen={() => { if (overlay.originalTextTruncated) void load().catch(() => undefined) }} loading={loading} error={error}>
        <RoomMessageMarkdown content={original} workingDir={body.workingDir} onOpenWorkspaceFile={body.onOpenWorkspaceFile}
          onOpenPreviewUrl={body.onOpenPreviewUrl} onOpenVisualization={body.onOpenVisualization} downloadSessionId={body.downloadSessionId} />
        <TranslationState state={overlay.state} errorCode={overlay.errorCode} enabled={enabled} onRetry={() => translations.retry(overlay)} />
      </TranslationComparison>
    </div>}
  </div>
}

function RoomChatMessage({
  message,
  senderName,
  senderMember,
  senderProvider,
  memberById,
  displayContent,
  onOpenImage,
  workingDir,
  onOpenWorkspaceFile,
  onOpenPreviewUrl,
  onOpenVisualization,
  previewWorkspaceId,
  previewSessionId,
  overlay,
  translations,
  translationEnabled,
  delivery,
  onRetrySubmission,
}: {
  message: RoomMessage
  senderName: string
  senderMember?: TeamMember | null
  senderProvider?: Provider | null
  memberById: Map<string, TeamMember>
  displayContent: string
  onOpenImage: (attachments: Attachment[], index: number) => void
  workingDir?: string
  onOpenWorkspaceFile?: (path: string, line?: number, column?: number) => void
  onOpenPreviewUrl?: (url: string, workspaceId?: string) => void
  onOpenVisualization?: (sessionId: string, file: string, workspaceId?: string) => void
  previewWorkspaceId?: string
  previewSessionId?: string
  overlay?: TeamRunTranslationOverlaySummary
  translations: RoomTranslations
  translationEnabled: boolean
  delivery?: MessageDelivery
  onRetrySubmission?: () => void
}) {
  const { t } = useI18n()
  const isUser = message.senderType === 'user'
  const isSystem = message.senderType === 'system'
  const pendingStatus = !delivery && isPendingRoomMessage(message) ? message.pendingStatus : null
  const mentions = message.mentions ?? []
  const workRequestCount = message.workRequestIds?.length ?? 0
  const isPrivate = message.visibility === 'PRIVATE'
  const handleOpenPreviewUrl = useCallback((url: string) => {
    onOpenPreviewUrl?.(url, previewWorkspaceId)
  }, [onOpenPreviewUrl, previewWorkspaceId])
  const handleOpenVisualization = useCallback((file: string) => {
    if (previewSessionId) onOpenVisualization?.(previewSessionId, file, previewWorkspaceId)
  }, [onOpenVisualization, previewSessionId, previewWorkspaceId])
  const recipientLabels = isPrivate ? getPrivateRecipientLabels(message, memberById) : []
  const body = {
    message, content: displayContent, attachmentIds: message.attachmentIds, isUser: isUser && pendingStatus !== 'failed',
    tone: isSystem ? 'system' as const : undefined, onOpenImage, workingDir, onOpenWorkspaceFile,
    onOpenPreviewUrl: onOpenPreviewUrl ? handleOpenPreviewUrl : undefined,
    onOpenVisualization: onOpenVisualization && previewSessionId ? handleOpenVisualization : undefined,
    downloadSessionId: previewSessionId,
  }
  const headerAddon = (
    <>
      {!isUser && !isSystem && senderProvider && (
        <ProviderBadge provider={senderProvider} />
      )}
      {isPrivate && (
        <span
          className="ml-0.5 inline-flex max-w-[18rem] shrink items-center gap-1 rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-xs font-medium leading-none text-foreground/70"
          title={recipientLabels.join(', ')}
        >
          <LockKeyhole size={10} />
          <span className="truncate">{t('Private')}{recipientLabels.length > 0 ? `: ${recipientLabels.join(', ')}` : ''}</span>
        </span>
      )}
      {!isSystem && workRequestCount > 0 && mentions.length === 0 && (
        <span className="ml-0.5 shrink-0 rounded-full bg-foreground/[0.08] px-1.5 py-0.5 text-xs font-medium leading-none text-foreground/70">
          {t('Work requests')}: {workRequestCount}
        </span>
      )}
      {pendingStatus === 'failed' && (
        <span className="ml-0.5 shrink-0 rounded-full bg-destructive/10 px-1.5 py-0.5 text-xs font-medium leading-none text-destructive-ink">
          {t('Acceptance unknown')}
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
      bubbleClassName={isUser && pendingStatus === 'failed' ? 'border border-destructive/25 bg-destructive/10 text-destructive-ink' : undefined}
      isPending={pendingStatus === 'sending'}
      footer={(delivery || message.userDelivery || pendingStatus === 'failed') ? <>
        {delivery && <MessageDeliveryFeedback delivery={delivery} />}
        {message.userDelivery && !delivery && <SentRoomComparison message={message} />}
        {pendingStatus === 'failed' && !delivery && <div className="text-xs"><p>{t('Acceptance unknown; check or retry the same submission.')}</p>{isPendingRoomMessage(message) && message.error && <p>{message.error}</p>}<button type="button" className="underline" onClick={onRetrySubmission}>{t('Retry original submission')}</button></div>}
      </> : undefined}
    >
      <TranslationReveal claim={translationEnabled ? translations.claimReveal : undefined} version={overlay?.state === 'SUCCESS' ? `${overlay.sourceId}:${overlay.sourceRevision}` : null} blocks=".team-room-message-markdown > div">{overlay ? <RoomTranslationBody key={`${overlay.sourceId}:${overlay.sourceRevision}:${overlay.overlayRevision}`} overlay={overlay} translations={translations} enabled={translationEnabled} body={body} />
        : <RoomMessageBody {...body} />}</TranslationReveal>
    </RoomMessageRow>
  )
}

function SentRoomComparison({ message }: { message: RoomMessage }) {
  const detail = useRoomMessageDetail(message.teamRunId, message.id, false)
  const delivery = message.userDelivery!
  if (delivery.sentMode !== 'TRANSLATED') return null
  const text = detail.data?.userDelivery?.actualSentText ?? delivery.actualSentText ?? ''
  const load = async () => {
    if (!delivery.isTruncated) return text
    const result = await detail.refetch()
    if (result.error || !result.data?.userDelivery) throw new Error('Failed to load sent text')
    return result.data.userDelivery.actualSentText ?? ''
  }
  return <TranslationComparison label="Actual sent text" original={text} getOriginal={load} onOpen={() => { if (delivery.isTruncated) void detail.refetch() }} loading={detail.isFetching} error={detail.error?.message}>
    <pre className="whitespace-pre-wrap">{text}</pre>
  </TranslationComparison>
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
      bubbleClassName="border border-warning/25 bg-warning/8"
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/25 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-ink">
            <Clock3 size={11} />
            {t('Pending approval')}
          </span>
          <span className="text-xs text-muted-foreground">{t('Requester')}: {t(request.requesterType === 'user' ? 'User' : request.requesterType === 'system' ? 'System' : 'Agent')}</span>
        </div>

        <div className="text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
          {request.instructionPreview ?? previewText(request.instruction)}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={isActionPending}
            className="border-success/25 bg-success/10 text-success-ink hover:bg-success/15 hover:text-success-ink"
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

interface RoomMessageListProps extends Pick<RoomTimelineProps, 'teamRun' | 'messages' | 'workingDir' | 'onOpenWorkspaceFile' | 'onOpenPreviewUrl' | 'onOpenVisualization'> {
  timelineItems: RoomTimelineItem[]
  recovered: Map<string, MessageDelivery>
  scrollElementRef: RefObject<HTMLElement | null>
  compact?: boolean
  onRetrySubmission: (message: PendingRoomMessage) => void
  onOpenImage: (images: Attachment[], index: number) => void
}

// Draft/mention/attachment updates must not visit the history or rebuild its
// translation query key. Keep the queries and Markdown below this memo boundary.
const RoomMessageList = memo(function RoomMessageList({
  teamRun, messages, timelineItems, recovered, scrollElementRef, compact,
  onRetrySubmission, onOpenImage, workingDir, onOpenWorkspaceFile,
  onOpenPreviewUrl, onOpenVisualization,
}: RoomMessageListProps) {
  const { t } = useI18n()
  const approveWorkRequest = useApproveWorkRequest(teamRun.id)
  const translations = useTeamRunTranslations(teamRun.id, messages)
  const { data: translationSettings } = useTranslationSettings()
  const translationByMessage = new Map(translations.overlays.map(row => [row.messageId, row]))
  const rejectWorkRequest = useRejectWorkRequest(teamRun.id)
  const { data: providersList } = useProviders()

  const providerById = useMemo(() => {
    const map = new Map<string, Provider>()
    for (const item of providersList ?? []) {
      map.set(item.provider.id, item.provider)
    }
    return map
  }, [providersList])

  const memberById = useMemo(() => new Map((teamRun.members ?? []).map(member => [member.id, member])), [teamRun.members])
  const invocationById = useMemo(() => {
    return new Map((teamRun.invocations ?? []).map((invocation) => [invocation.id, invocation]))
  }, [teamRun.invocations])

  const pendingApprovalError =
    approveWorkRequest.isError
      ? approveWorkRequest.error
      : rejectWorkRequest.isError
        ? rejectWorkRequest.error
        : null

  const isPendingApprovalActionPending =
    approveWorkRequest.isPending
    || rejectWorkRequest.isPending

  const [expandedMessages] = useState(() => new Map<string, ExpandedMessageState>())
  useEffect(() => {
    const ids = new Set(messages.map(message => message.id))
    for (const id of expandedMessages.keys()) if (!ids.has(id)) expandedMessages.delete(id)
  }, [expandedMessages, messages])

  const renderItem = (item: RoomTimelineItem) => {
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
    const senderProvider = senderMember?.providerId
      ? providerById.get(senderMember.providerId) ?? null
      : null
    const senderInvocation = message.senderInvocationId
      ? invocationById.get(message.senderInvocationId)
      : undefined
    const senderWorkspaceId = senderInvocation?.workspaceId ?? undefined
    const senderSessionId = senderInvocation?.sessionId ?? undefined

    return (
      <RoomChatMessage
        key={item.key}
        message={message}
        senderName={senderName}
        senderMember={senderMember}
        senderProvider={senderProvider}
        memberById={memberById}
        displayContent={displayContent}
        overlay={translationByMessage.get(message.id)}
        translations={translations}
        translationEnabled={translationSettings?.enabled === true}
        delivery={recovered.get(message.userDelivery?.clientSubmissionId ?? message.id)}
        onRetrySubmission={isPendingRoomMessage(message) ? () => onRetrySubmission(message) : undefined}
        onOpenImage={onOpenImage}
        workingDir={workingDir}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        onOpenPreviewUrl={onOpenPreviewUrl}
        onOpenVisualization={onOpenVisualization}
        previewWorkspaceId={senderWorkspaceId}
        previewSessionId={senderSessionId}
      />
    )
  }

  return <ExpandedMessagesContext.Provider value={expandedMessages}>
    {timelineItems.length === 0 ? (
      <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background text-muted-foreground">
        <Users size={24} className="text-muted-foreground/70" />
        <span className="text-sm">{t('No room messages yet')}</span>
      </div>
    ) : (
      <VirtualRoomMessageList items={timelineItems} renderItem={renderItem} scrollElementRef={scrollElementRef} compact={compact} />
    )}
    {pendingApprovalError && <div className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive-ink">
      {getErrorMessage(pendingApprovalError, t('Failed to update work request'))}
    </div>}
  </ExpandedMessagesContext.Provider>
})

export function RoomTimeline({
  teamRun,
  messages,
  readOnly,
  readOnlyMessage,
  onSendMessage,
  onViewInvocationSession,
  changeSummaryBar,
  compactComposer,
  centered,
  workingDir,
  onOpenWorkspaceFile,
  onOpenPreviewUrl,
  onOpenVisualization,
}: RoomTimelineProps) {
  const { t } = useI18n()
  const stopMemberWork = useStopMemberWork(teamRun.id)
  const [draft, setDraft] = useState('')
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false)
  const [inlineMention, setInlineMention] = useState<{ start: number; end: number; query: string } | null>(null)
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0)
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const deliveryRecovery = useMessageDeliveries(readOnly ? '' : `task:${teamRun.taskId}`, 'pending', 'TEAM_TASK')
  const sentRecovery = useMessageDeliveries(readOnly ? '' : `task:${teamRun.taskId}`, 'sent', 'TEAM_TASK')
  const recovered = useMemo(() => new Map([...deliveryRecovery.data?.pages.flatMap(p => p.items) ?? [], ...sentRecovery.data?.pages.flatMap(p => p.items) ?? []].filter(item => item.destination.kind === 'TEAM_ROOM' && item.destination.teamRunId === teamRun.id).sort((a, b) => a.revision - b.revision).map(item => [item.clientSubmissionId, item])), [deliveryRecovery.data, sentRecovery.data, teamRun.id])
  const [pendingMessages, setPendingMessages] = useState<PendingRoomMessage[]>([])
  const [stopPromptInvocationId, setStopPromptInvocationId] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const {
    files: attachmentFiles,
    addFiles,
    removeFile,
    clear: clearAttachments,
    buildMarkdownLinks,
    getDoneAttachments,
    isUploading,
  } = useAttachments()
  const hasSendableAttachments = attachmentFiles.some((file) => file.status === 'done' && file.attachment)
  const [lightboxState, setLightboxState] = useState<{ images: Attachment[]; index: number } | null>(null)

  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    resize: 'instant',
    initial: 'instant',
  })
  const userScrolledAwayRef = useRef(false)
  const previousLatestItemKeyRef = useRef<string | null>(null)
  const previousRoomIdRef = useRef(teamRun.id)
  const jumpToBottom = useCallback(() => {
    userScrolledAwayRef.current = false
    // A smooth trip through thousands of virtual rows repeatedly mounts and
    // measures intermediate messages. Jump directly, then let the stick hook
    // follow the final rows as their estimated heights are measured.
    return scrollToBottom({ animation: 'instant', ignoreEscapes: true })
  }, [scrollToBottom])

  useEffect(() => {
    if (previousRoomIdRef.current === teamRun.id) return
    previousRoomIdRef.current = teamRun.id
    const frame = requestAnimationFrame(() => { void jumpToBottom() })
    return () => cancelAnimationFrame(frame)
  }, [jumpToBottom, teamRun.id])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        userScrolledAwayRef.current = true
        return
      }

      if (event.deltaY > 0 && element.scrollHeight - element.scrollTop - element.clientHeight <= 70) {
        userScrolledAwayRef.current = false
      }
    }

    element.addEventListener('wheel', handleWheel, { passive: true })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [scrollRef])

  const memberById = useMemo(() => {
    return new Map((teamRun.members ?? []).map((member) => [member.id, member]))
  }, [teamRun.members])

  const activeMembers = useMemo(
    () => (teamRun.members ?? []).filter(isActiveTeamMember),
    [teamRun.members],
  )

  const acceptedSubmissionIds = useMemo(() => new Set([
    ...messages.flatMap(message => message.userDelivery ? [message.userDelivery.clientSubmissionId] : []),
    ...(deliveryRecovery.data?.pages.flatMap(page => page.items.map(item => item.clientSubmissionId)) ?? []),
  ]), [messages, deliveryRecovery.data])
  useEffect(() => {
    for (const id of acceptedSubmissionIds) forgetTeamRoomSubmission(teamRun.id, id)
    setPendingMessages(current => current.some(message => acceptedSubmissionIds.has(message.id))
      ? current.filter(message => !acceptedSubmissionIds.has(message.id)) : current)
  }, [acceptedSubmissionIds, teamRun.id])

  const messageList = useMemo(() => {
    const confirmedIds = new Set(messages.map(message => message.id))
    const published = new Set(messages.flatMap(message => message.userDelivery ? [message.userDelivery.clientSubmissionId] : []))
    const recoveredMessages = [...recovered.values()].filter(item => item.state !== 'CANCELLED' && !published.has(item.clientSubmissionId)).map(item => ({
      ...createPendingRoomMessage(teamRun.id, { content: item.originalText, clientSubmissionId: item.clientSubmissionId, attachmentIds: item.attachmentIds }),
      pendingStatus: 'sending' as const, createdAt: item.createdAt,
    }))
    const visiblePendingMessages = pendingMessages.filter(message => !confirmedIds.has(message.id) && !published.has(message.id) && !recovered.has(message.id))
    return [...messages, ...recoveredMessages, ...visiblePendingMessages].sort((a, b) => Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? ''))
  }, [messages, pendingMessages, recovered, teamRun.id])

  const workRequestById = useMemo(() => {
    return new Map((teamRun.workRequests ?? []).map((request) => [request.id, request]))
  }, [teamRun.workRequests])

  const timelineItems = useMemo(
    () => buildRoomTimelineItems(messageList, teamRun.workRequests ?? [], teamRun.invocations ?? []),
    [messageList, teamRun.invocations, teamRun.workRequests],
  )

  useEffect(() => {
    const latestItemKey = timelineItems.at(-1)?.key ?? null
    const previousLatestItemKey = previousLatestItemKeyRef.current
    previousLatestItemKeyRef.current = latestItemKey

    if (
      previousLatestItemKey == null
      || latestItemKey == null
      || latestItemKey === previousLatestItemKey
      || userScrolledAwayRef.current
    ) {
      return
    }

    const frame = requestAnimationFrame(() => {
      void scrollToBottom({ animation: 'instant', preserveScrollPosition: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [scrollToBottom, timelineItems])

  const activeInvocations = useMemo(
    () => (teamRun.invocations ?? []).filter((invocation) => ACTIVE_ROOM_INVOCATION_STATUSES.has(invocation.status)),
    [teamRun.invocations],
  )

  const selectedMembers = useMemo(() => {
    return selectedMemberIds
      .map((memberId) => memberById.get(memberId))
      .filter((member): member is TeamMember => Boolean(member))
      .filter(isActiveTeamMember)
  }, [memberById, selectedMemberIds])

  const mentionCandidates = useMemo(() => {
    const query = inlineMention?.query ?? ''
    return activeMembers
      .filter((member) => memberMatchesQuery(member, query))
      .sort((a, b) => {
        const aSelected = selectedMemberIds.includes(a.id)
        const bSelected = selectedMemberIds.includes(b.id)
        if (aSelected !== bSelected) return aSelected ? 1 : -1
        return a.name.localeCompare(b.name)
      })
  }, [activeMembers, inlineMention?.query, selectedMemberIds])

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
    }
  }, [addFiles])

  const handleSubmit = useCallback(async () => {
    if (readOnly || isSubmitting || isUploading) return
    const attachmentMarkdown = buildMarkdownLinks()
    const attachmentIds = getDoneAttachments().map((attachment) => attachment.id)
    const mentions = buildStructuredMentionsFromSelectedMembers(selectedMemberIds, activeMembers)
    const input = buildRoomMessageSubmitInput({
      draft,
      attachmentMarkdown,
      attachmentIds,
      mentions,
    })
    if (!input || (!draft.trim() && !hasSendableAttachments)) return

    input.clientSubmissionId = createUuid()
    const pendingMessage = createPendingRoomMessage(teamRun.id, input)

    setPendingMessages((current) => [...current, pendingMessage])
    setDraft('')
    setSelectedMemberIds([])
    setMentionPickerOpen(false)
    setInlineMention(null)
    clearAttachments()
    if (textareaRef.current) {
      textareaRef.current.style.height = compactComposer ? '40px' : '72px'
    }
    requestAnimationFrame(() => jumpToBottom())

    setIsSubmitting(true)
    try {
      const savedMessage = await onSendMessage(input)
      setPendingMessages((current) => current.filter((message) => message.id !== pendingMessage.id))
      if (savedMessage && typeof savedMessage === 'object' && 'id' in savedMessage) {
        requestAnimationFrame(() => jumpToBottom())
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to send room message'
      setPendingMessages((current) => current.map((item) => item.id === pendingMessage.id
        ? { ...item, pendingStatus: 'failed', error: message }
        : item))
      requestAnimationFrame(() => jumpToBottom())
    } finally {
      setIsSubmitting(false)
    }
  }, [activeMembers, buildMarkdownLinks, clearAttachments, compactComposer, draft, getDoneAttachments, hasSendableAttachments, isSubmitting, isUploading, jumpToBottom, onSendMessage, readOnly, selectedMemberIds, teamRun.id])

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
    setPendingMessages(pendingTeamRoomSubmissions(teamRun.id).map(input => ({ ...createPendingRoomMessage(teamRun.id, input), pendingStatus: 'failed', error: 'Acceptance unknown; check or retry the same submission.' })))
    clearAttachments()
    userScrolledAwayRef.current = false
    previousLatestItemKeyRef.current = null
    setStopPromptInvocationId(null)
    if (textareaRef.current) {
      textareaRef.current.style.height = compactComposer ? '40px' : '72px'
    }
  }, [clearAttachments, compactComposer, teamRun.id])

  const handleOpenImage = useCallback((images: Attachment[], index: number) => {
    setLightboxState({ images, index })
  }, [])

  const handleRetrySubmission = useCallback((message: PendingRoomMessage) => {
    if (isSubmitting) return
    setIsSubmitting(true)
    void onSendMessage(message.submissionInput)
      .then(() => setPendingMessages(current => current.filter(item => item.id !== message.id)))
      .finally(() => setIsSubmitting(false))
      .catch(() => undefined)
  }, [isSubmitting, onSendMessage])

  const handleStopMember = useCallback((memberId: string, cancelQueued: boolean) => {
    stopMemberWork.mutate(
      { memberId, cancelQueued },
      { onSuccess: () => setStopPromptInvocationId(null) },
    )
  }, [stopMemberWork])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
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
          data-room-scroll
          className={cn(
            'h-full overflow-y-auto scrollbar-app-thin bg-background',
            compactComposer ? 'px-3 py-3' : 'px-4 py-4',
          )}
        >
          <div ref={contentRef} className={cn(compactComposer ? 'space-y-2.5' : 'space-y-3', centered && 'max-w-4xl mx-auto')}>
            <RoomMessageList
              key={teamRun.id}
              teamRun={teamRun}
              messages={messages}
              timelineItems={timelineItems}
              recovered={recovered}
              scrollElementRef={scrollRef}
              compact={compactComposer}
              onRetrySubmission={handleRetrySubmission}
              onOpenImage={handleOpenImage}
              workingDir={workingDir}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
              onOpenPreviewUrl={onOpenPreviewUrl}
              onOpenVisualization={onOpenVisualization}
            />

            <TeamRoomDeliveryStatus taskId={teamRun.taskId} teamRunId={teamRun.id} enabled={!readOnly} showDeliveries={false} />
            {stopMemberWork.isError && (
              <div className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive-ink">
                {getErrorMessage(stopMemberWork.error, t('Failed to stop member work'))}
              </div>
            )}
          </div>
        </div>

        {!isAtBottom && (
          <button
            type="button"
            onClick={() => jumpToBottom()}
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-background/90 px-3 py-1.5 text-xs text-foreground/70 shadow-raised backdrop-blur-sm hover:bg-background hover:text-foreground transition-colors"
          >
            <ArrowDown size={14} />
            <span>{t('Back to bottom')}</span>
          </button>
        )}
      </div>

      <div className={cn(
        'shrink-0 border-t border-transparent bg-background',
        compactComposer ? 'px-3 pb-2 pt-1.5' : 'px-6 pb-6 pt-2',
      )}>
        <div className={cn(centered && 'max-w-4xl mx-auto')}>
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
        {!readOnly && changeSummaryBar}
        {readOnly ? (
          <div className="rounded-xl border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
            {readOnlyMessage ?? t('This project is read-only')}
          </div>
        ) : (
          <div className="relative rounded-xl border border-border bg-background shadow-raised transition-all duration-200 hover:shadow-raised focus-within:border-ring focus-within:shadow-raised">
            {mentionMenuOpen && (
              <div className="absolute bottom-full left-3 z-20 mb-2 w-[min(24rem,calc(100vw-3rem))] overflow-hidden rounded-xl border border-border bg-background shadow-popover">
                <div className="border-b border-border/60 px-3 py-2 text-xs font-medium text-muted-foreground">
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
                          highlighted ? 'bg-muted' : 'hover:bg-accent',
                        )}
                      >
                        <MemberAvatar
                          name={member.name}
                          avatar={member.avatar}
                          className="h-8 w-8 text-[11px]"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">{member.name}</span>
                            {selected && (
                              <span className="rounded-full bg-primary px-1.5 py-0.5 text-xs font-medium text-primary-foreground">
                                {t('selected')}
                              </span>
                            )}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {[member.providerId, member.id.slice(0, 8)]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        </div>
                        <AtSign size={15} className="text-muted-foreground/70" />
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {selectedMembers.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
                {selectedMembers.map((member) => (
                  <span
                    key={member.id}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-1 text-xs text-foreground/80"
                  >
                    <span className="truncate font-medium">@{member.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{member.id.slice(0, 8)}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveSelectedMention(member.id)}
                      className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground/80"
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
                'w-full resize-none border-none bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none',
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
                  className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground/70"
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
                  disabled={selectedMembers.length === 0 && activeMembers.length === 0}
                  title={t('Mention members')}
                  aria-label={t('Mention members')}
                  className={cn(
                    'rounded-lg transition-colors',
                    compactComposer ? 'p-1.5' : 'p-2',
                    mentionPickerOpen
                      ? 'bg-muted text-foreground/80'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground/70',
                    selectedMembers.length === 0 && activeMembers.length === 0
                      ? 'cursor-not-allowed opacity-50'
                      : '',
                  )}
                >
                  <AtSign size={compactComposer ? 15 : 18} />
                </button>
                {selectedMembers.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {selectedMembers.length} {t('selected')}
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={readOnly || isSubmitting || isUploading || (!draft.trim() && !hasSendableAttachments)}
                aria-busy={isSubmitting}
                title={isUploading ? t('Uploading...') : isSubmitting ? t('发送中...') : t('发送')}
                aria-label={isUploading ? t('Uploading...') : isSubmitting ? t('发送中...') : t('发送')}
                className={cn(
                  'rounded-lg transition-all duration-200',
                  compactComposer ? 'p-1.5' : 'p-2',
                  (draft.trim() || hasSendableAttachments) && !readOnly && !isSubmitting && !isUploading
                    ? 'bg-primary text-primary-foreground shadow-raised hover:bg-primary'
                    : 'cursor-not-allowed bg-transparent text-muted-foreground',
                  isSubmitting || isUploading ? 'opacity-70' : '',
                )}
              >
                {isSubmitting ? <Loader2 size={compactComposer ? 15 : 18} className="animate-spin" /> : <ArrowUp size={compactComposer ? 15 : 18} />}
              </button>
            </div>


          </div>
        )}
        </div>
      </div>
    </div>
  )
}
