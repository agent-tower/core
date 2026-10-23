import { useOutgoingSubmissions } from '@/hooks/outgoing-submissions'
import { OutgoingSubmissionBubble } from '@/components/agent/OutgoingSubmissionBubble'
import { getProviderStartIssue } from '@/components/provider/provider-draft'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ArrowLeft, CircleAlert, LayoutList, LoaderCircle, MessageSquare, Search, Settings, SquarePen, Trash2 } from 'lucide-react'
import { SessionStatus } from '@agent-tower/shared'
import type { Conversation } from '@agent-tower/shared'
import { ServerEvents, type SessionCompletedPayload } from '@agent-tower/shared/socket'
import { AgentSessionPanel } from '@/components/agent'
import type { AgentSessionSendInput } from '@/components/agent'
import { BrandLockup } from '@/components/BrandLogo'
import { CreateTaskInput } from '@/components/task/CreateTaskInput'
import { sidebarRowClass } from '@/components/task/sidebar-styles'
import { formatTaskUpdatedAt } from '@/components/task/task-time'
import { TaskGradientText } from '@/components/task/TaskGradientText'
import { IconButton, NavGroup, NavRow, Skeleton, SkeletonRows } from '@/design-system'
import { useProviders } from '@/hooks/use-providers'
import { isProviderEnabled } from '@/lib/provider-selection'
import {
  useConversation,
  useConversations,
  useCreateConversation,
  useDeleteConversation,
  useSendConversationMessage,
  useStopConversation,
} from '@/hooks/use-conversations'
import { queryKeys } from '@/hooks/query-keys'
import { socketManager } from '@/lib/socket/manager'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/ui-store'
import { useQueryClient } from '@tanstack/react-query'
import { useDesktopNavigate, useDesktopTitlebar } from '@/lib/desktop-titlebar'

type StartStep = 'idle' | 'starting-session'
const TICK_INTERVAL = 30_000
const CONVERSATION_READ_STORAGE_KEY = 'agent-tower:conversation-read-times'

type ConversationReadTimes = Record<string, number>

function loadConversationReadTimes(): ConversationReadTimes {
  try {
    const rawValue = window.localStorage.getItem(CONVERSATION_READ_STORAGE_KEY)
    if (!rawValue) return {}
    const parsed = JSON.parse(rawValue) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([id, value]) => [id, typeof value === 'number' ? value : Number(value)] as const)
        .filter((entry): entry is [string, number] => Number.isFinite(entry[1])),
    )
  } catch {
    return {}
  }
}

function persistConversationReadTimes(readTimes: ConversationReadTimes) {
  try {
    window.localStorage.setItem(CONVERSATION_READ_STORAGE_KEY, JSON.stringify(readTimes))
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

function getConversationActivityTime(conversation: Conversation): number {
  const value = conversation.lastActiveAt ?? conversation.updatedAt ?? conversation.createdAt
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

function useTick(interval = TICK_INTERVAL) {
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), interval)
    return () => clearInterval(id)
  }, [interval])
}

function isRunning(status?: SessionStatus | string) {
  return status === SessionStatus.RUNNING || status === SessionStatus.PENDING
}

function statusLabel(status: SessionStatus | string, t: (key: string) => string) {
  switch (status) {
    case SessionStatus.RUNNING:
      return t('Running')
    case SessionStatus.PENDING:
      return t('Starting')
    case SessionStatus.COMPLETED:
      return t('Completed')
    case SessionStatus.FAILED:
      return t('Failed')
    case SessionStatus.CANCELLED:
      return t('Stopped')
    default:
      return status
  }
}

function ConversationStatusIndicator({
  status,
  unread,
}: {
  status: SessionStatus | string
  unread: boolean
}) {
  const { t } = useI18n()
  const label = unread ? t('Unread') : statusLabel(status, t)
  const icon = isRunning(status)
    ? <LoaderCircle className="size-3 text-info motion-safe:animate-spin" aria-hidden="true" />
    : unread
      ? <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
      : status === SessionStatus.FAILED
        ? <CircleAlert className="size-3 text-destructive" aria-hidden="true" />
        : null

  if (!icon) return null

  return <span role="img" aria-label={label} title={label} className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
}

function ConversationTitle({ conversation, selected = false, unread = false }: {
  conversation: Conversation
  selected?: boolean
  unread?: boolean
}) {
  const className = cn(
    'min-w-0 flex-1 truncate',
    unread ? 'font-semibold text-foreground' : selected || isRunning(conversation.status) || conversation.status === SessionStatus.FAILED
      ? 'text-foreground'
      : 'text-muted-foreground',
  )

  if (isRunning(conversation.status)) {
    return <TaskGradientText text={conversation.title} variant="running" animate={!selected} className={className} />
  }

  return <span className={className}>{conversation.title}</span>
}

function ConversationListSkeleton() {
  return (
    <div className="flex-1 overflow-hidden px-2 pt-3" aria-hidden="true">
      <div className="flex h-8 items-center gap-2.5 px-2 pointer-coarse:h-10">
        <Skeleton className="size-4 shrink-0" />
        <Skeleton className="h-3 w-14" />
      </div>
      <SkeletonRows rows={6} className="mt-0.5 space-y-px pointer-coarse:[&>div]:h-10" />
    </div>
  )
}

function handleSidebarKeyDown(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-sidebar-item]:not(:disabled)'))
  const index = items.indexOf(event.target as HTMLElement)
  if (index === -1) return
  event.preventDefault()
  items[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
}

function ConversationListItem({
  conversation,
  selected,
  onSelect,
  onDelete,
  disabled,
  unread,
}: {
  conversation: Conversation
  selected: boolean
  onSelect: () => void
  onDelete: () => void
  disabled?: boolean
  unread: boolean
}) {
  const { t, locale } = useI18n()
  const updatedAt = conversation.lastActiveAt ?? conversation.updatedAt ?? conversation.createdAt

  return (
    <div className="group/conversation relative min-w-0">
      <button
        type="button"
        onClick={onSelect}
        title={conversation.title}
        aria-current={selected || undefined}
        data-sidebar-item=""
        className={cn(sidebarRowClass(selected), 'task-row animate-task-enter group-hover/conversation:pr-9 group-focus-within/conversation:pr-9 pointer-coarse:pr-10')}
      >
        <ConversationTitle conversation={conversation} selected={selected} unread={unread} />
        <ConversationStatusIndicator status={conversation.status} unread={unread} />
        {updatedAt && (
          <span className="task-row-meta group-focus-within/conversation:hidden">
            <time dateTime={updatedAt} className="text-[11px] tabular-nums text-muted-foreground">
              {formatTaskUpdatedAt(updatedAt, t, locale)}
            </time>
          </span>
        )}
      </button>
      <IconButton
        size="xs"
        label={`${t('Delete')} · ${conversation.title}`}
        onClick={(event) => {
          event.stopPropagation()
          onDelete()
        }}
        disabled={disabled}
        className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground opacity-0 hover:text-destructive group-hover/conversation:pointer-events-auto group-hover/conversation:opacity-100 group-focus-within/conversation:pointer-events-auto group-focus-within/conversation:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:size-8 pointer-coarse:opacity-100"
      >
        <Trash2 size={14} />
      </IconButton>
    </div>
  )
}

function ConversationSearchModal({
  isOpen,
  conversations,
  onClose,
  onSelectConversation,
}: {
  isOpen: boolean
  conversations: Conversation[]
  onClose: () => void
  onSelectConversation: (conversation: Conversation) => void
}) {
  const { t, locale } = useI18n()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [isOpen])

  const results = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return conversations.slice(0, 12)
    return conversations
      .filter((conversation) => conversation.title.toLowerCase().includes(normalizedQuery))
      .slice(0, 50)
  }, [conversations, query])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    const item = listRef.current?.children[activeIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const handleSelect = useCallback((conversation: Conversation) => {
    onSelectConversation(conversation)
    onClose()
  }, [onClose, onSelectConversation])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((value) => Math.min(value + 1, results.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((value) => Math.max(value - 1, 0))
      return
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      const conversation = results[activeIndex]
      if (conversation) handleSelect(conversation)
    }
  }, [activeIndex, handleSelect, onClose, results])

  if (!isOpen) return null

  const hasQuery = query.trim().length > 0

  return (
    <div className="fixed inset-0 z-90" role="dialog" aria-modal="true" aria-label={t('Search conversations...')}>
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      <div className="absolute left-1/2 top-[18vh] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-popover animate-in fade-in zoom-in-95 duration-100">
        <div className="flex items-center gap-2.5 border-b border-border/60 px-4">
          <Search size={15} className="shrink-0 text-muted-foreground/70" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('Search conversations...')}
            aria-label={t('Search conversations...')}
            autoFocus
            className="min-w-0 flex-1 border-none bg-transparent py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none pointer-coarse:text-[15px]"
          />
        </div>

        {results.length > 0 ? (
          <>
            {!hasQuery ? (
              <div className="px-4 pb-1 pt-2.5 text-xs font-medium text-muted-foreground">
                {t('Recent conversations')}
              </div>
            ) : null}
            <div ref={listRef} className="max-h-[46vh] overflow-y-auto pb-1.5 pt-0.5 scrollbar-app-thin">
              {results.map((conversation, index) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => handleSelect(conversation)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 pointer-coarse:min-h-10 pointer-coarse:text-[15px]',
                    index === activeIndex && 'bg-accent',
                  )}
                >
                  <MessageSquare size={14} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-foreground" title={conversation.title}>
                    {conversation.title}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {formatTaskUpdatedAt(conversation.lastActiveAt ?? conversation.updatedAt ?? conversation.createdAt ?? '', t, locale)}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('No matching conversations')}
          </div>
        )}
      </div>
    </div>
  )
}

export function ConversationPage() {
  const { t } = useI18n()
  useTick()
  const navigate = useDesktopNavigate()
  const { usesIntegratedTitlebar, desktopPlatform, hasMacTrafficLights } = useDesktopTitlebar()
  const hasWindowsWindowControls = usesIntegratedTitlebar && desktopPlatform === 'win32'
  const { conversationId } = useParams<{ conversationId: string }>()
  const queryClient = useQueryClient()

  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [step, setStep] = useState<StartStep>('idle')
  const [isCreatingNew, setIsCreatingNew] = useState(false)
  const [creationEpoch, setCreationEpoch] = useState(0)
  const creationView = useRef({ conversationId, isCreatingNew, epoch: creationEpoch })
  if (creationView.current.conversationId !== conversationId || creationView.current.isCreatingNew !== isCreatingNew || creationView.current.epoch !== creationEpoch) {
    creationView.current = { conversationId, isCreatingNew, epoch: creationEpoch }
  }
  const currentCreationView = creationView.current
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [conversationReadTimes, setConversationReadTimes] = useState<ConversationReadTimes>(loadConversationReadTimes)
  const [unreadConversationIds, setUnreadConversationIds] = useState<Set<string>>(() => new Set())

  const { data: conversations = [], isLoading: isListLoading } = useConversations()
  const { data: selectedConversation, isLoading: isConversationLoading } = useConversation(conversationId)
  const { data: providersData = [], isLoading: isProvidersLoading } = useProviders()
  const outgoing = useOutgoingSubmissions('new-conversation')
  const createConversation = useCreateConversation()
  const sendConversationMessage = useSendConversationMessage()
  const stopConversation = useStopConversation()
  const deleteConversation = useDeleteConversation()
  const activeConversation = selectedConversation
    ?? conversations.find((conversation) => conversation.id === conversationId)
    ?? null

  const startProviderOptions = useMemo(() => providersData.filter(isProviderEnabled).map(item => {
    const reason = getProviderStartIssue(item)
    return {
      id: item.provider.id,
      name: item.provider.name,
      agentType: item.provider.agentType,
      available: !reason,
      permissionMode: item.provider.executionPermission,
      reason,
    }
  }), [providersData])
  const isDetailRoute = Boolean(conversationId)
  const showMainOnMobile = isDetailRoute || isCreatingNew

  const invalidateConversation = useCallback((id?: string | null) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all })
    if (id) {
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(id) })
    }
  }, [queryClient])

  const invalidateActiveConversation = useCallback(() => {
    invalidateConversation(conversationId)
  }, [conversationId, invalidateConversation])

  const markConversationRead = useCallback((conversation: Conversation) => {
    setUnreadConversationIds((current) => {
      if (!current.has(conversation.id)) return current
      const next = new Set(current)
      next.delete(conversation.id)
      return next
    })

    if (conversation.status !== SessionStatus.COMPLETED) return

    const readAt = Math.max(Date.now(), getConversationActivityTime(conversation))
    setConversationReadTimes((current) => {
      if (current[conversation.id] && current[conversation.id] >= readAt) return current
      const next = { ...current, [conversation.id]: readAt }
      persistConversationReadTimes(next)
      return next
    })
  }, [])

  const markConversationUnread = useCallback((id: string) => {
    setUnreadConversationIds((current) => {
      if (current.has(id)) return current
      const next = new Set(current)
      next.add(id)
      return next
    })
  }, [])

  const forgetConversationReadState = useCallback((id: string) => {
    setUnreadConversationIds((current) => {
      if (!current.has(id)) return current
      const next = new Set(current)
      next.delete(id)
      return next
    })
    setConversationReadTimes((current) => {
      if (!(id in current)) return current
      const next = { ...current }
      delete next[id]
      persistConversationReadTimes(next)
      return next
    })
  }, [])

  const conversationsBySessionId = useMemo(() => {
    const bySessionId = new Map<string, Conversation>()
    for (const conversation of conversations) {
      bySessionId.set(conversation.sessionId, conversation)
    }
    if (activeConversation) {
      bySessionId.set(activeConversation.sessionId, activeConversation)
    }
    return bySessionId
  }, [activeConversation, conversations])

  const isConversationUnread = useCallback((conversation: Conversation) => {
    if (conversation.status !== SessionStatus.COMPLETED) return false
    if (unreadConversationIds.has(conversation.id)) return true
    return getConversationActivityTime(conversation) > (conversationReadTimes[conversation.id] ?? 0)
  }, [conversationReadTimes, unreadConversationIds])

  useEffect(() => {
    if (activeConversation || startProviderOptions.some(option => option.id === selectedProviderId)) return
    setSelectedProviderId(startProviderOptions.find(option => option.available)?.id ?? '')
  }, [activeConversation, selectedProviderId, startProviderOptions])

  useEffect(() => {
    if (activeConversation?.providerId) {
      setSelectedProviderId(activeConversation.providerId)
    }
  }, [activeConversation?.providerId])

  useEffect(() => {
    if (conversationId) {
      setIsCreatingNew(false)
    }
  }, [conversationId])

  useEffect(() => {
    if (!activeConversation) return
    markConversationRead(activeConversation)
  }, [activeConversation, markConversationRead])

  useEffect(() => {
    const socket = socketManager.connect()
    const handleSessionCompleted = (payload: SessionCompletedPayload) => {
      const completedConversation = conversationsBySessionId.get(payload.sessionId)
      if (!completedConversation) return

      invalidateConversation(completedConversation.id)
      if (payload.status !== SessionStatus.COMPLETED) {
        markConversationRead(completedConversation)
        return
      }

      if (completedConversation.id === conversationId) {
        markConversationRead(completedConversation)
        return
      }

      markConversationUnread(completedConversation.id)
    }
    socket.on(ServerEvents.SESSION_COMPLETED, handleSessionCompleted)
    return () => {
      socket.off(ServerEvents.SESSION_COMPLETED, handleSessionCompleted)
    }
  }, [
    conversationId,
    conversationsBySessionId,
    invalidateConversation,
    markConversationRead,
    markConversationUnread,
  ])

  const handleNewConversation = () => {
    // Opening the same route is a new intent, even while its old POST is pending.
    creationView.current = { conversationId: undefined, isCreatingNew: true, epoch: creationView.current.epoch + 1 }
    setCreationEpoch(creationView.current.epoch)
    setStep('idle')
    setIsCreatingNew(true)
    navigate('/conversations')
  }

  const handleBackToList = () => {
    setIsCreatingNew(false)
    navigate('/conversations')
  }

  const handleSelectConversation = useCallback((conversation: Conversation) => {
    markConversationRead(conversation)
    setIsCreatingNew(false)
    navigate(`/conversations/${conversation.id}`)
  }, [markConversationRead, navigate])

  const handleStartConversation = async (data: {
    title: string
    providerId: string
    attachmentIds?: string[]
  }) => {
    if (!data.providerId || !data.title.trim() || step !== 'idle') return

    setStep('starting-session')
    const submittedView = creationView.current
    try {
      const conversation = await createConversation.mutateAsync({
        prompt: data.title.trim(),
        providerId: data.providerId,
        attachmentIds: data.attachmentIds,
      })
      if (creationView.current === submittedView) {
        setSelectedProviderId(data.providerId)
        setIsCreatingNew(false)
        navigate(`/conversations/${conversation.id}`)
      }
    } finally {
      if (creationView.current === submittedView) setStep('idle')
    }
  }

  const handleSend = async (input: AgentSessionSendInput) => {
    if (!activeConversation || (!input.message.trim() && !input.attachmentIds?.length) || sendConversationMessage.isPending) return

    await sendConversationMessage.mutateAsync({
      id: activeConversation.id,
      sessionId: activeConversation.sessionId,
      message: input.message,
      providerId: input.providerId || selectedProviderId || undefined,
      attachmentIds: input.attachmentIds,
    })
  }

  const handleStop = async () => {
    // AgentSessionPanel owns visibility via runtime activity. Conversation
    // detail can still contain the message enqueue response from before RUNNING.
    if (!activeConversation || stopConversation.isPending) return
    await stopConversation.mutateAsync(activeConversation.id)
  }

  const handleDelete = async (id: string) => {
    const shouldDelete = window.confirm(t('Delete this conversation?'))
    if (!shouldDelete) return
    await deleteConversation.mutateAsync(id)
    forgetConversationReadState(id)
    if (conversationId === id) {
      setIsCreatingNew(false)
      navigate('/conversations')
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-sidebar text-sm text-foreground">
      <header
        className={cn(
          'flex h-12 shrink-0 items-center justify-between bg-sidebar px-4',
          usesIntegratedTitlebar && 'app-region-drag',
          hasWindowsWindowControls && 'pr-[150px]',
        )}
      >
        <div className={cn(
          'flex min-w-0 items-center gap-2',
          hasMacTrafficLights && 'pl-[72px]',
        )}>
          <BrandLockup />
          <span className="mx-1.5 select-none text-muted-foreground">/</span>
          <span className="truncate text-sm font-medium text-foreground/90">{t('Conversation')}</span>
        </div>
        <button
          type="button"
          onClick={() => useUIStore.getState().openSettings()}
          className={cn(
            'rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
            usesIntegratedTitlebar && 'app-region-no-drag',
          )}
          title={t('Settings')}
        >
          <Settings size={16} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          onKeyDown={handleSidebarKeyDown}
          className={cn(
            'h-full w-full shrink-0 flex-col bg-sidebar md:flex md:w-[320px]',
            showMainOnMobile ? 'hidden md:flex' : 'flex',
          )}
        >
          <div className="flex shrink-0 flex-col gap-px px-2 pb-1 pt-2">
            <NavRow
              onClick={handleNewConversation}
              active={!conversationId}
              icon={<SquarePen />}
              label={t('New Conversation')}
              title={t('New Conversation')}
            />
            <NavRow
              onClick={() => navigate('/')}
              icon={<LayoutList />}
              label={t('Tasks')}
              title={t('Tasks')}
            />
            <NavRow
              onClick={() => setIsSearchOpen(true)}
              icon={<Search />}
              label={t('Search')}
              title={t('Search')}
            />
          </div>

          {isListLoading ? (
            <ConversationListSkeleton />
          ) : conversations.length === 0 ? (
            <div className="flex flex-1 select-none flex-col items-center justify-center px-6 pb-[10vh] text-center">
              <MessageSquare size={36} aria-hidden="true" className="mb-3 text-muted-foreground/50" strokeWidth={1.5} />
              <p className="mb-4 text-sm text-muted-foreground">{t('No conversations')}</p>
              <button
                type="button"
                onClick={handleNewConversation}
                className="rounded-md bg-brand px-3.5 py-1.5 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2"
              >
                {t('New Conversation')}
              </button>
            </div>
          ) : (
            <div className="relative min-h-0 flex-1 overflow-y-auto scrollbar-app-thin scroll-pt-8 pointer-coarse:scroll-pt-10">
              <div className="px-2 pb-4 pt-3">
                <NavGroup title={t('History')} icon={<MessageSquare />} count={conversations.length} sticky>
                  {conversations.map((conversation) => (
                    <ConversationListItem
                      key={conversation.id}
                      conversation={conversation}
                      selected={conversation.id === conversationId}
                      disabled={deleteConversation.isPending}
                      unread={conversation.id !== conversationId && isConversationUnread(conversation)}
                      onSelect={() => handleSelectConversation(conversation)}
                      onDelete={() => handleDelete(conversation.id)}
                    />
                  ))}
                </NavGroup>
              </div>
            </div>
          )}

          {!isListLoading && (
            <div className="flex h-9 shrink-0 items-center justify-between border-t border-border/60 px-4 text-xs text-muted-foreground">
              <span className="tabular-nums">{t('Conversations')} · {conversations.length}</span>
            </div>
          )}
        </aside>

        <main
          className={cn(
            'min-w-0 flex-1 flex-col bg-background md:mb-2 md:mr-2 md:overflow-hidden md:rounded-xl md:border md:border-border/50',
            showMainOnMobile ? 'flex' : 'hidden md:flex',
          )}
        >
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-4 md:px-5">
            <div className="flex min-w-0 items-center gap-3">
              {isDetailRoute || isCreatingNew ? (
                <button
                  type="button"
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 md:hidden"
                  onClick={handleBackToList}
                  title={t('Back')}
                >
                  <ArrowLeft size={17} />
                </button>
              ) : null}
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">
                  {activeConversation?.title ?? t('New Conversation')}
                </div>
                {activeConversation ? (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {statusLabel(activeConversation.status, t)}
                    {activeConversation.directoryName ? ` · ${activeConversation.directoryName}` : ''}
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          {!activeConversation && isDetailRoute ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-sm text-muted-foreground">
              {isConversationLoading ? t('Loading...') : t('Conversation not found')}
            </div>
          ) : !activeConversation ? (
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 pb-[10vh] md:px-8">
              <div className="w-full max-w-2xl animate-[fadeInUp_0.5s_cubic-bezier(0.16,1,0.3,1)]">
                {outgoing.map(item => <OutgoingSubmissionBubble key={item.id} item={item} onConversationCreated={id => { if (creationView.current === currentCreationView) navigate(`/conversations/${id}`) }} />)}
                <h1 className="mb-5 max-w-full break-words text-center text-[22px] font-medium leading-snug tracking-tight text-foreground md:mb-6 md:text-[26px]">
                  {t('需要我帮你做点什么？')}
                </h1>
                <CreateTaskInput
                  key={creationEpoch}
                  variant="conversation"
                  projects={[]}
                  providers={startProviderOptions}
                  isProvidersLoading={isProvidersLoading}
                  defaultProviderId={selectedProviderId}
                  createStep={step}
                  placeholder="Ask a question..."
                  submitLabel="Start"
                  pendingLabel="Starting..."
                  submitTitle="Start"
                  onSubmit={async ({ title, providerId, attachmentIds }) => {
                    await handleStartConversation({ title, providerId, attachmentIds })
                  }}
                />
              </div>
            </div>
          ) : (
            <AgentSessionPanel
              sessionId={activeConversation.sessionId}
              sessionStatus={activeConversation.status}
              sessionStartedAt={activeConversation.createdAt}
              sessionEndedAt={isRunning(activeConversation.status)
                ? null
                : activeConversation.lastActiveAt ?? activeConversation.updatedAt}
              agentType={activeConversation.agentType}
              runtimeType={activeConversation.runtimeType}
              providerId={selectedProviderId || activeConversation.providerId}
              providers={providersData}
              initialTokenUsage={activeConversation.tokenUsage}
              onProviderChange={setSelectedProviderId}
              onSend={handleSend}
              onStop={handleStop}
              onExit={invalidateActiveConversation}
              isSending={sendConversationMessage.isPending}
              isStopping={stopConversation.isPending}
            />
          )}
        </main>
      </div>

      <ConversationSearchModal
        isOpen={isSearchOpen}
        conversations={conversations}
        onClose={() => setIsSearchOpen(false)}
        onSelectConversation={handleSelectConversation}
      />
    </div>
  )
}
