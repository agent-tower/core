import { useCallback, useEffect, useRef, useState } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { ArrowDown, ArrowUp, Paperclip, Square } from 'lucide-react'
import { SessionStatus } from '@agent-tower/shared'
import { LogStream } from './LogStream'
import { TodoPanel } from './TodoPanel'
import { TokenUsageIndicator } from './TokenUsageBar'
import { ProviderSelector } from '@/components/task/ProviderSelector'
import { AttachmentPreview } from '@/components/ui/AttachmentPreview'
import { useAttachments } from '@/hooks/use-attachments'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import { useTodos } from '@/hooks/use-todos'
import { useTokenUsage, type TokenUsageInfo } from '@/hooks/useTokenUsage'
import { useNormalizedLogs } from '@/lib/socket/hooks/useNormalizedLogs'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export interface AgentSessionSendInput {
  message: string
  providerId?: string
  attachmentIds?: string[]
}

interface AgentSessionPanelProps {
  sessionId: string
  sessionStatus?: SessionStatus | string
  agentType: string
  providerId?: string | null
  providers: ProviderWithAvailability[]
  initialTokenUsage?: TokenUsageInfo | null
  onProviderChange?: (providerId: string) => void
  onSend: (input: AgentSessionSendInput) => Promise<void>
  onStop: () => Promise<void>
  onExit?: (exitCode: number) => void
  isSending?: boolean
  isStopping?: boolean
  canStop?: boolean
  className?: string
}

function isActiveStatus(status?: SessionStatus | string): boolean {
  return status === SessionStatus.RUNNING || status === SessionStatus.PENDING
}

export function AgentSessionPanel({
  sessionId,
  sessionStatus,
  agentType,
  providerId,
  providers,
  initialTokenUsage,
  onProviderChange,
  onSend,
  onStop,
  onExit,
  isSending = false,
  isStopping = false,
  canStop,
  className,
}: AgentSessionPanelProps) {
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const [selectedProviderId, setSelectedProviderId] = useState(providerId ?? '')
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputContainerRef = useRef<HTMLDivElement>(null)
  const sendingRef = useRef(false)
  const { scrollRef, contentRef, isAtBottom, scrollToBottom, stopScroll } = useStickToBottom({
    initial: 'instant',
    resize: 'smooth',
  })

  const {
    isConnected,
    isLoadingSnapshot,
    isOutputActive,
    lastExitAt,
    logs,
    entries,
    attach,
  } = useNormalizedLogs({
    sessionId,
    sessionStatus,
    onExit,
  })

  const { todos } = useTodos(entries)
  const tokenUsage = useTokenUsage(logs, initialTokenUsage)
  const {
    files: attachmentFiles,
    addFiles,
    removeFile,
    clear: clearAttachments,
    buildMarkdownLinks,
    getDoneAttachments,
    hasFiles: hasAttachments,
    isUploading,
  } = useAttachments()

  const isSessionActive = isActiveStatus(sessionStatus)
  const canStopSession = canStop ?? isSessionActive

  useEffect(() => {
    setSelectedProviderId(providerId ?? '')
  }, [providerId])

  useEffect(() => {
    if (sessionId && isConnected) {
      attach()
    }
  }, [sessionId, isConnected, attach])

  const handleProviderSelect = useCallback((nextProviderId: string) => {
    setSelectedProviderId(nextProviderId)
    onProviderChange?.(nextProviderId)
  }, [onProviderChange])

  const resetTextareaHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '60px'
    }
  }, [])

  const handleInput = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value)
    const el = event.target
    el.style.height = 'auto'
    el.style.height = `${Math.max(60, Math.min(el.scrollHeight, 300))}px`
  }, [])

  const handleSend = useCallback(async () => {
    if ((!input.trim() && !hasAttachments) || sendingRef.current || isSending || isUploading) return
    sendingRef.current = true

    const attachmentLinks = buildMarkdownLinks()
    const attachmentIds = getDoneAttachments().map((attachment) => attachment.id)
    const message = [input.trim(), attachmentLinks].filter(Boolean).join('\n\n')

    setInput('')
    clearAttachments()
    resetTextareaHeight()
    setError(null)

    try {
      await onSend({
        message,
        providerId: selectedProviderId || undefined,
        attachmentIds,
      })
      await attach()
      requestAnimationFrame(() => scrollToBottom('smooth'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Send failed. Please try again.'))
      setInput(message)
    } finally {
      sendingRef.current = false
    }
  }, [
    input,
    hasAttachments,
    isSending,
    isUploading,
    buildMarkdownLinks,
    getDoneAttachments,
    clearAttachments,
    resetTextareaHeight,
    onSend,
    selectedProviderId,
    attach,
    scrollToBottom,
    t,
  ])

  const handleStop = useCallback(async () => {
    if (!canStopSession || isStopping) return
    await onStop()
  }, [canStopSession, isStopping, onStop])

  const handleFileInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files
    if (fileList && fileList.length > 0) {
      addFiles(Array.from(fileList))
    }
    event.target.value = ''
  }, [addFiles])

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const items = event.clipboardData.items
    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      event.preventDefault()
      addFiles(files)
    }
  }, [addFiles])

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    setIsDragOver(false)
    const fileList = event.dataTransfer.files
    if (fileList.length > 0) {
      addFiles(Array.from(fileList))
    }
  }, [addFiles])

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col bg-background', className)}>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto scrollbar-app-thin px-6 pb-4 pt-6">
          <div ref={contentRef} className="mx-auto w-full min-w-0 max-w-4xl">
            {isLoadingSnapshot ? (
              <div className="flex items-center justify-center gap-3 py-12 text-muted-foreground/70">
                <svg className="h-5 w-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-sm">{t('Loading logs...')}</span>
              </div>
            ) : logs.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground/70">
                {isSessionActive ? t('Waiting for agent output...') : t('No logs recorded for this session.')}
              </div>
            ) : (
              <LogStream
                logs={logs}
                isOutputActive={isOutputActive}
                lastExitAt={lastExitAt}
                onUserToggleDetails={stopScroll}
              />
            )}
          </div>
        </div>

        {!isAtBottom && (
          <button
            type="button"
            onClick={() => scrollToBottom()}
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-md backdrop-blur-sm transition-all hover:bg-background hover:text-foreground"
            aria-label={t('Scroll to bottom')}
          >
            <ArrowDown size={14} />
            <span>{t('Back to bottom')}</span>
          </button>
        )}
      </div>

      {todos.length > 0 && (
        <div className="shrink-0 border-t border-border/60 bg-background px-6 pb-1 pt-2">
          <div className="mx-auto max-w-4xl">
            <TodoPanel todos={todos} />
          </div>
        </div>
      )}

      <div
        className="z-10 w-full shrink-0 border-t border-transparent bg-background p-6 pb-6 pt-2"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="mx-auto max-w-4xl">
          {error ? (
            <div className="mb-2 text-sm text-destructive">{error}</div>
          ) : null}
          <div
            ref={inputContainerRef}
            className={cn(
              'relative rounded-xl border bg-background transition-colors duration-200 hover:border-ring/40 focus-within:border-ring/60',
              isDragOver ? 'border-info bg-info/5' : 'border-border',
            )}
          >
            <AttachmentPreview files={attachmentFiles} onRemove={removeFile} />

            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.repeat && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                  event.preventDefault()
                  handleSend()
                }
              }}
              rows={1}
              placeholder={isDragOver ? t('Drop files here...') : sessionId && !isSessionActive ? t('Continue conversation...') : t('Message Agent...')}
              className="w-full resize-none border-none bg-transparent px-4 pb-2 pt-4 text-sm leading-relaxed text-foreground placeholder-muted-foreground/70 focus:outline-none"
              style={{ minHeight: '60px', maxHeight: '300px' }}
            />

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
            />

            <div className="flex items-center justify-between px-2 pb-2 pt-1">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                  className="rounded-lg p-2 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  title={t('Upload file')}
                >
                  <Paperclip size={18} />
                </button>
              </div>

              <div className="flex items-center gap-2">
                <ProviderSelector
                  providers={providers}
                  currentProviderId={selectedProviderId}
                  agentType={agentType}
                  onSelect={handleProviderSelect}
                />
                <TokenUsageIndicator usage={tokenUsage} />
                {canStopSession && isSessionActive && !input.trim() && !hasAttachments ? (
                  <button
                    type="button"
                    onClick={handleStop}
                    disabled={isStopping}
                    className="rounded-lg bg-destructive p-2 text-white transition-all duration-200 hover:bg-destructive/90 disabled:opacity-50"
                    title={t('Stop')}
                  >
                    <Square size={14} />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={(!input.trim() && !hasAttachments) || isUploading || isSending}
                    className={cn(
                      'rounded-lg p-2 transition-all duration-200',
                      (input.trim() || hasAttachments) && !isUploading && !isSending
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : 'cursor-not-allowed bg-transparent text-muted-foreground/50',
                    )}
                    title={t('Send')}
                  >
                    <ArrowUp size={18} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
