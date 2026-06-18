import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ArrowLeft, LayoutList, MessageSquare, Search, Settings, SquarePen, Trash2 } from 'lucide-react'
import { SessionStatus } from '@agent-tower/shared'
import type { Conversation } from '@agent-tower/shared'
import { ServerEvents, type SessionCompletedPayload } from '@agent-tower/shared/socket'
import { AgentSessionPanel } from '@/components/agent'
import type { AgentSessionSendInput } from '@/components/agent'
import { BrandLogo, BrandLogoTitle } from '@/components/BrandLogo'
import { CreateTaskInput } from '@/components/task/CreateTaskInput'
import { useProviders } from '@/hooks/use-providers'
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
import { translate, useI18n } from '@/lib/i18n'
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

function timeAgo(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const diff = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (diff < 60) return translate('{count}s ago', { count: diff })
  if (diff < 3600) return translate('{count}m ago', { count: Math.floor(diff / 60) })
  if (diff < 86400) return translate('{count}h ago', { count: Math.floor(diff / 3600) })
  return translate('{count}d ago', { count: Math.floor(diff / 86400) })
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

function BlinkingStatusDot({ className, pulseClassName }: { className: string; pulseClassName: string }) {
  return (
    <span className="relative inline-flex h-2 w-2">
      <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full', pulseClassName)} />
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', className)} />
    </span>
  )
}

function ConversationStatusDot({
  status,
  unread,
}: {
  status: SessionStatus | string
  unread: boolean
}) {
  if (isRunning(status)) {
    return <BlinkingStatusDot className="bg-success" pulseClassName="bg-success/70" />
  }
  if (unread) {
    return <BlinkingStatusDot className="bg-warning" pulseClassName="bg-warning/70" />
  }
  return null
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
  const { t } = useI18n()
  const updatedAt = timeAgo(conversation.lastActiveAt ?? conversation.createdAt)
  const showStatusDot = isRunning(conversation.status) || unread

  return (
    <div
      className={cn(
        'group ml-4 mr-2 flex items-center rounded-md transition-colors',
        selected ? 'bg-accent' : 'hover:bg-accent/50',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        title={conversation.title}
        className="flex min-w-0 flex-1 animate-task-enter items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm"
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <MessageSquare size={14} className="text-muted-foreground" />
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            selected ? 'font-medium text-foreground' : 'text-foreground/90',
          )}
        >
          {conversation.title}
        </span>
        {showStatusDot ? (
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            <ConversationStatusDot status={conversation.status} unread={unread} />
          </span>
        ) : (
          <span className="flex w-14 shrink-0 items-center justify-end text-[11px] tabular-nums text-muted-foreground/50">
            <span className="truncate group-hover:hidden">{updatedAt}</span>
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onDelete()
        }}
        disabled={disabled}
        className="mr-1 hidden shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-background hover:text-destructive disabled:opacity-50 group-hover:flex"
        title={t('Delete')}
      >
        <Trash2 size={14} />
      </button>
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
  const { t } = useI18n()
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
    <div className="fixed inset-0 z-90" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      <div className="absolute left-1/2 top-[18vh] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-lg animate-in fade-in zoom-in-95 duration-100">
        <div className="flex items-center gap-2.5 border-b border-border/60 px-4">
          <Search size={15} className="shrink-0 text-muted-foreground/70" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('Search conversations...')}
            aria-label={t('Search conversations...')}
            autoFocus
            className="flex-1 border-none bg-transparent py-3 text-sm text-foreground placeholder-muted-foreground/60 focus:outline-none"
          />
        </div>

        {results.length > 0 ? (
          <>
            {!hasQuery ? (
              <div className="px-4 pb-1 pt-2.5 text-[11px] font-medium text-muted-foreground/70">
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
                    'flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors',
                    index === activeIndex && 'bg-accent',
                  )}
                >
                  <MessageSquare size={14} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground/90" title={conversation.title}>
                    {conversation.title}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground/60">
                    {timeAgo(conversation.lastActiveAt ?? conversation.createdAt)}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground/70">
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
  const { usesIntegratedTitlebar } = useDesktopTitlebar()
  const { conversationId } = useParams<{ conversationId: string }>()
  const queryClient = useQueryClient()

  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [step, setStep] = useState<StartStep>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isCreatingNew, setIsCreatingNew] = useState(false)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [conversationReadTimes, setConversationReadTimes] = useState<ConversationReadTimes>(loadConversationReadTimes)
  const [unreadConversationIds, setUnreadConversationIds] = useState<Set<string>>(() => new Set())

  const { data: conversations = [], isLoading: isListLoading } = useConversations()
  const { data: selectedConversation, isLoading: isConversationLoading } = useConversation(conversationId)
  const { data: providersData = [], isLoading: isProvidersLoading } = useProviders()
  const createConversation = useCreateConversation()
  const sendConversationMessage = useSendConversationMessage()
  const stopConversation = useStopConversation()
  const deleteConversation = useDeleteConversation()
  const activeConversation = selectedConversation
    ?? conversations.find((conversation) => conversation.id === conversationId)
    ?? null

  const availableProviders = useMemo(
    () => providersData.filter(({ availability }) => availability.type !== 'NOT_FOUND'),
    [providersData],
  )

  const startProviderOptions = availableProviders.map(({ provider }) => ({
    id: provider.id,
    name: provider.name,
    available: true,
  }))
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
    if (!selectedProviderId && availableProviders.length > 0) {
      setSelectedProviderId(availableProviders[0]!.provider.id)
    }
  }, [availableProviders, selectedProviderId])

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
    setError(null)
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
    setError(null)
    try {
      const conversation = await createConversation.mutateAsync({
        prompt: data.title.trim(),
        providerId: data.providerId,
        attachmentIds: data.attachmentIds,
      })
      setSelectedProviderId(data.providerId)
      setIsCreatingNew(false)
      navigate(`/conversations/${conversation.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to start. Please try again.'))
    } finally {
      setStep('idle')
    }
  }

  const handleSend = async (input: AgentSessionSendInput) => {
    if (!activeConversation || !input.message.trim() || sendConversationMessage.isPending) return

    await sendConversationMessage.mutateAsync({
      id: activeConversation.id,
      message: input.message,
      providerId: input.providerId || selectedProviderId || undefined,
      attachmentIds: input.attachmentIds,
    })
  }

  const handleStop = async () => {
    if (!activeConversation || !isRunning(activeConversation.status) || stopConversation.isPending) return
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
        )}
      >
        <div className={cn(
          'flex min-w-0 items-center gap-2',
          usesIntegratedTitlebar && 'pl-[72px]',
        )}>
          <BrandLogo />
          <BrandLogoTitle />
          <span className="mx-1.5 select-none text-muted-foreground/40">/</span>
          <span className="truncate text-sm font-medium text-foreground/90">{t('Conversation')}</span>
        </div>
        <button
          type="button"
          onClick={() => useUIStore.getState().openSettings()}
          className={cn(
            'rounded-md p-1.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground',
            usesIntegratedTitlebar && 'app-region-no-drag',
          )}
          title={t('Settings')}
        >
          <Settings size={16} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className={cn(
            'h-full w-full shrink-0 flex-col bg-sidebar md:flex md:w-[320px]',
            showMainOnMobile ? 'hidden md:flex' : 'flex',
          )}
        >
          <div className="shrink-0 px-2 pb-1 pt-2">
            <button
              type="button"
              onClick={handleNewConversation}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors',
                isCreatingNew
                  ? 'bg-accent text-foreground'
                  : 'text-foreground/80 hover:bg-accent/50',
              )}
              title={t('New Conversation')}
            >
              <SquarePen size={16} className="text-muted-foreground" />
              <span>{t('New Conversation')}</span>
            </button>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-sm text-foreground/80 transition-colors hover:bg-accent/50"
              title={t('Tasks')}
            >
              <LayoutList size={16} className="text-muted-foreground" />
              <span>{t('Tasks')}</span>
            </button>
            <button
              type="button"
              onClick={() => setIsSearchOpen(true)}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-sm text-foreground/80 transition-colors hover:bg-accent/50"
              title={t('Search')}
            >
              <Search size={16} className="text-muted-foreground" />
              <span>{t('Search')}</span>
            </button>
          </div>

          <div className="relative min-h-0 flex-1 overflow-y-auto scrollbar-app-thin pb-4 pt-3">
            {isListLoading ? (
              <div className="px-4 py-4 text-sm text-muted-foreground">{t('Loading...')}</div>
            ) : conversations.length === 0 ? (
              <div className="flex h-full select-none flex-col items-center justify-center px-6 text-center">
                <MessageSquare size={36} className="mb-3 text-muted-foreground/40" strokeWidth={1.5} />
                <p className="mb-4 text-sm text-muted-foreground">{t('No conversations')}</p>
                <button
                  type="button"
                  onClick={handleNewConversation}
                  className="rounded-md bg-brand px-3.5 py-1.5 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand/90"
                >
                  {t('New Conversation')}
                </button>
              </div>
            ) : (
              <div className="mb-2">
                <div className="flex w-full items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-muted-foreground">
                  <span className="flex-1 text-left">{t('History')}</span>
                  <span className="text-[11px] font-normal tabular-nums text-muted-foreground/50">
                    {conversations.length}
                  </span>
                </div>
                <div className="mt-0.5 flex min-h-[40px] flex-col rounded-md">
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
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-border/60 px-4 py-3 text-xs text-muted-foreground/70">
            <span>{t('Conversations')} · {conversations.length}</span>
          </div>
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
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
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
                <h1 className="mb-8 max-w-full break-words text-center text-3xl leading-tight tracking-tight text-foreground">
                  {t('需要我帮你做点什么？')}
                </h1>
                <CreateTaskInput
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
                {error ? (
                  <div className="mt-3 rounded-lg border border-destructive/15 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    {error}
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <AgentSessionPanel
              sessionId={activeConversation.sessionId}
              sessionStatus={activeConversation.status}
              agentType={activeConversation.agentType}
              providerId={selectedProviderId || activeConversation.providerId}
              providers={providersData}
              initialTokenUsage={activeConversation.tokenUsage}
              onProviderChange={setSelectedProviderId}
              onSend={handleSend}
              onStop={handleStop}
              onExit={invalidateActiveConversation}
              isSending={sendConversationMessage.isPending}
              isStopping={stopConversation.isPending}
              canStop={isRunning(activeConversation.status)}
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
