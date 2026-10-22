import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Popover } from 'radix-ui'
import { Copy, Languages, X } from 'lucide-react'
import type { SessionTranslationOverlay } from '@agent-tower/shared'
import { useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { useI18n } from '@/lib/i18n'
import { queryKeys } from '@/hooks/query-keys'
import { translationErrorMessage } from '@/hooks/use-translation-settings'

export function CopyTranslationText({ text, label, getText, canCopy }: { text: string; label: string; getText?: () => Promise<string>; canCopy?: () => boolean }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<string | null>(null)
  const busy = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const copy = async () => {
    if (busy.current) return
    busy.current = true
    try {
      const fullText = getText ? await getText() : text
      if (!alive.current || canCopy && !canCopy()) return
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(fullText)
      else {
        const active = document.activeElement as HTMLElement | null
        const textarea = document.createElement('textarea')
        textarea.value = fullText
        textarea.readOnly = true
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        try { textarea.focus(); textarea.select(); if (!document.execCommand('copy')) throw new Error() }
        finally { textarea.remove(); active?.focus() }
      }
      if (alive.current) setStatus('已复制')
    } catch { if (alive.current) setStatus('Copy failed.') }
    finally { busy.current = false }
  }
  return <span className="inline-flex items-center gap-1">
    <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={label} onClick={() => {
      void copy()
    }}><Copy size={12} />{label}</button>
    {status && <span className="text-xs text-muted-foreground" role="status">{t(status)}</span>}
  </span>
}

export function TranslationComparison({ original, children, onOpen, getOriginal, canCopy, loading, error, label = 'Original' }: {
  label?: string; original: string; children: React.ReactNode; onOpen?: () => void; getOriginal?: () => Promise<string>;
  canCopy?: () => boolean; loading?: boolean; error?: string | null
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const skipFocus = useRef(false)
  const restoreFocus = useRef(false)
  const focusContent = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const title = useId()
  const panelId = useId()
  const clearTimer = () => { if (timer.current) clearTimeout(timer.current) }
  const close = (restore = false) => { clearTimer(); restoreFocus.current = restore; setOpen(false) }
  const closeLater = () => {
    clearTimer()
    timer.current = setTimeout(() => {
      if (!content.current?.contains(document.activeElement) && document.activeElement !== trigger.current) close()
    }, 250)
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const onOpenRef = useRef(onOpen)
  useEffect(() => { onOpenRef.current = onOpen }, [onOpen])
  useEffect(() => { if (open) onOpenRef.current?.() }, [open])
  return <Popover.Root open={open} onOpenChange={value => { restoreFocus.current = false; setOpen(value) }}>
    <Popover.Anchor asChild><button type="button" ref={trigger} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label={t(label)} title={t(label)}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onPointerEnter={event => { if (event.pointerType === 'mouse') { clearTimer(); setOpen(true) } }} onPointerLeave={closeLater}
      onFocus={() => { if (!skipFocus.current) { clearTimer(); setOpen(true) } skipFocus.current = false }}
      onBlur={closeLater} onClick={() => { clearTimer(); setOpen(true) }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey && open)) {
          event.preventDefault(); focusContent.current = true; setOpen(true)
          content.current?.querySelector('button')?.focus()
        }
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true) }
      }}><Languages size={14} aria-hidden="true" /></button></Popover.Anchor>
    <Popover.Portal><Popover.Content ref={content} id={panelId} align="start" sideOffset={6} collisionPadding={12}
      aria-labelledby={title} className="z-[80] flex max-h-[var(--radix-popover-content-available-height)] w-[min(36rem,calc(100vw-24px))] flex-col rounded-xl border border-border bg-background p-4 text-foreground shadow-xl outline-none"
      onOpenAutoFocus={event => { event.preventDefault(); if (focusContent.current) content.current?.querySelector('button')?.focus(); focusContent.current = false }}
      onFocusOutside={event => {
        // Focus can mount this content before the opening focusin reaches Radix's
        // document listener. Anchor does not register a Trigger, so exempt it here.
        if (event.target === trigger.current) event.preventDefault()
      }}
      onCloseAutoFocus={event => {
        event.preventDefault()
        if (restoreFocus.current && document.activeElement !== trigger.current) { skipFocus.current = true; trigger.current?.focus() }
        restoreFocus.current = false
      }}
      onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); close(true) }}
      onPointerEnter={clearTimer} onPointerLeave={closeLater} onFocus={clearTimer} onBlur={closeLater}>
      <div className="mb-3 flex shrink-0 items-center justify-between gap-2"><h3 id={title} className="text-sm font-medium">{t(label)}</h3>
        <div className="flex items-center gap-2"><CopyTranslationText text={original} getText={getOriginal} canCopy={canCopy} label={t(label === 'Original' ? 'Copy original' : '复制')} /><button type="button" aria-label={t('关闭')} onClick={() => close(true)} className="rounded p-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"><X size={15} /></button></div>
      </div>
      {loading && <span role="status" className="text-xs text-muted-foreground">{t('Loading')}</span>}
      {error && <div role="alert" className="text-xs text-destructive">{error}<button type="button" onClick={onOpen} className="ml-2 underline">{t('Retry')}</button></div>}
      <div tabIndex={0} aria-label={t(label)} className="max-h-[min(55vh,28rem)] min-h-0 overflow-y-auto overscroll-contain break-words pr-2 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{children}</div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}

/** Animate only a changed presentation version, never streaming deltas or initial history. */
export function TranslationReveal({ version, claim, children }: { version: string | null; claim?: (version: string) => boolean; children: React.ReactNode }) {
  const element = useRef<HTMLDivElement>(null)
  const previous = useRef(version)
  useLayoutEffect(() => {
    const changed = previous.current !== version
    previous.current = version
    // Claim even on a row's initial mount: virtual remounts and reduced motion
    // must not defer a completion event until an unrelated later render.
    const fresh = version !== null && claim?.(version)
    if (!changed || !fresh || !element.current?.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const animation = element.current.animate([{ opacity: 0.55, transform: 'translateY(2px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180, easing: 'ease-out' })
    return () => animation.cancel()
  }, [version, claim])
  return <div ref={element} data-translation-version={version ?? 'original'}>{children}</div>
}

const retryable = new Set(['FAILED', 'CANCELLED', 'INTERRUPTED', 'QUEUE_FULL', 'PAUSED_DISABLED'])
const stateLabels: Record<string, string> = {
  PENDING: 'Waiting for translation', RUNNING: 'Translating…', RETRY_WAIT: 'Waiting to retry translation',
  FAILED: 'Translation failed', CANCELLED: 'Translation cancelled', INTERRUPTED: 'Translation interrupted',
  QUEUE_FULL: 'Translation queue full', PAUSED_DISABLED: 'Translation paused',
}

export function TranslationStatus({ overlay, enabled }: { overlay: SessionTranslationOverlay; enabled: boolean }) {
  const client = useQueryClient()
  return <TranslationState state={overlay.state} errorCode={overlay.errorCode} enabled={enabled} onRetry={async () => {
    try { await apiClient.post(`/sessions/${encodeURIComponent(overlay.sessionId)}/translations/${encodeURIComponent(overlay.sourceId)}/retry`, { expectedRevision: overlay.sourceRevision }) }
    finally { void client.invalidateQueries({ queryKey: queryKeys.sessionTranslations.session(overlay.sessionId) }) }
  }} />
}

export function TranslationState({ state, errorCode, enabled, onRetry }: { state: string; errorCode?: string | null; enabled: boolean; onRetry: () => Promise<unknown> }) {
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const label = stateLabels[state]
  if (!label) return null
  const showReason = state === 'FAILED' || errorCode && (retryable.has(state) || state === 'RETRY_WAIT')
  return <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    <span>{t(label)}</span>
    {enabled && retryable.has(state) && <button type="button" disabled={pending} className="rounded px-1.5 py-1 underline hover:bg-muted disabled:opacity-50" onClick={async () => {
      if (busy.current) return
      busy.current = true
      setPending(true); setError(null)
      try {
        await onRetry()
      } catch (cause) { if (alive.current) setError(translationErrorMessage(cause)) }
      finally {
        busy.current = false
        if (alive.current) setPending(false)
      }
    }}>{t(pending ? 'Retrying…' : 'Retry translation')}</button>}
    {showReason && <p role="alert" className="w-full break-words text-destructive">
      {t(translationErrorMessage(errorCode))}{errorCode && <> <span className="font-mono">({errorCode})</span></>}
    </p>}
    {error && <span role="alert">{t(error)}</span>}
  </div>
}
