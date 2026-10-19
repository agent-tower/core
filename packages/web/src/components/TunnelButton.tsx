import { useState, useCallback } from 'react'
import { Smartphone, Copy, Check, X, Shield, RefreshCw, AlertTriangle } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { Button, IconButton, Input, Notice, Popover, PopoverClose, PopoverContent, PopoverTrigger, Spinner } from '@/design-system'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useTunnelStatus, useStartTunnel, useStopTunnel, useRegenerateTunnel, type TunnelStatus } from '@/hooks/use-tunnel'

function toneForStatus(status: TunnelStatus | undefined) {
  if (!status || status.status === 'stopped') {
    return {
      button: 'text-muted-foreground hover:text-foreground hover:bg-accent',
      dot: '',
      label: 'Use Agent Tower on your phone',
      icon: 'idle' as const,
    }
  }

  switch (status.status) {
    case 'healthy':
    case 'checking':
      return {
        button: 'text-success-ink hover:bg-success/10',
        dot: 'bg-success',
        label: status.status === 'healthy' ? 'Tunnel healthy' : 'Checking tunnel health',
        icon: 'ok' as const,
      }
    case 'degraded':
    case 'localUnhealthy':
    case 'linkReplaced':
      return {
        button: 'text-warning-ink hover:bg-warning/10',
        dot: 'bg-warning',
        label: 'Tunnel needs attention',
        icon: 'warn' as const,
      }
    case 'exited':
    case 'error':
      return {
        button: 'text-destructive-ink hover:bg-destructive/10',
        dot: 'bg-destructive',
        label: 'Tunnel unavailable',
        icon: 'error' as const,
      }
    case 'starting':
      return {
        button: 'text-warning-ink hover:bg-warning/10',
        dot: 'bg-warning',
        label: 'Tunnel starting',
        icon: 'loading' as const,
      }
  }
}

function statusText(status: TunnelStatus | undefined): string {
  if (!status || status.status === 'stopped') return 'Tunnel is off'

  switch (status.status) {
    case 'healthy':
      return 'Tunnel healthy'
    case 'checking':
      return 'Checking tunnel health'
    case 'degraded':
      return 'Observing original link'
    case 'localUnhealthy':
      return 'Local service unavailable'
    case 'exited':
      return 'Tunnel process exited'
    case 'error':
      return 'Tunnel error'
    case 'linkReplaced':
      return 'New link generated'
    case 'starting':
      return 'Tunnel starting'
  }
}

function statusDescription(status: TunnelStatus | undefined): string {
  if (!status || status.status === 'stopped') return 'Start a temporary Quick Tunnel when you need to share this Agent Tower session.'

  switch (status.status) {
    case 'healthy':
      return 'The Cloudflare tunnel is running and the local Agent Tower health check passed.'
    case 'checking':
      return 'The Cloudflare tunnel is running. Agent Tower is waiting for the first local health check.'
    case 'degraded':
      return 'The original public URL is currently unreachable. Agent Tower is watching for it to recover and will not generate a new link automatically.'
    case 'localUnhealthy':
      return 'The local Agent Tower target is not responding, so the tunnel cannot be considered healthy.'
    case 'exited':
      return 'The tunnel process has exited. The old Quick Tunnel link is unlikely to recover.'
    case 'error':
      return 'The tunnel reported an error. Check the diagnostics before generating a new link.'
    case 'linkReplaced':
      return 'A new Quick Tunnel link was generated. The old link and token are no longer valid.'
    case 'starting':
      return 'Agent Tower is asking Cloudflare Quick Tunnel for a temporary public URL.'
  }
}

function relativeTime(value: string | null | undefined): string {
  if (!value) return 'Never'
  const then = new Date(value).getTime()
  if (!Number.isFinite(then)) return value

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function getTunnelAlertDiagnostics(status: TunnelStatus | undefined): string {
  if (!status) return ''

  const diagnostics = [
    present(status.lastLocalError),
    present(status.lastRemoteError),
    present(status.lastError),
  ].filter((value): value is string => value !== null)

  const processOutput = present(status.lastProcessOutput)
  const shouldShowProcessOutput = Boolean(processOutput)
    && (status.status === 'error' || status.status === 'exited' || Boolean(present(status.lastError)))

  if (processOutput && shouldShowProcessOutput) {
    diagnostics.push(processOutput)
  }

  return diagnostics.join('\n')
}

export function TunnelButton() {
  const { t } = useI18n()
  const { data: status } = useTunnelStatus()
  const startTunnel = useStartTunnel()
  const stopTunnel = useStopTunnel()
  const regenerateTunnel = useRegenerateTunnel()
  const [showPopover, setShowPopover] = useState(false)
  const [copied, setCopied] = useState<'url' | 'token' | null>(null)
  const [showToken, setShowToken] = useState(false)
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)

  const isActive = status?.status !== undefined && status.status !== 'stopped'
  const isLoading = startTunnel.isPending || status?.status === 'starting'
  const isRegenerating = regenerateTunnel.isPending
  const shareableUrl = status?.shareableUrl
  const token = status?.token
  const tone = toneForStatus(status)
  const currentStatusText = statusText(status)
  const diagnostics = getTunnelAlertDiagnostics(status)
  const statusInk = status?.status === 'healthy' || status?.status === 'checking'
    ? 'text-success-ink'
    : status?.status === 'exited' || status?.status === 'error'
      ? 'text-destructive-ink'
      : 'text-warning-ink'

  const handleStart = useCallback(() => {
    startTunnel.mutate(undefined, {
      onSuccess: () => setShowPopover(true),
    })
  }, [startTunnel])

  const handleCopyUrl = useCallback(() => {
    if (!shareableUrl) return
    navigator.clipboard.writeText(shareableUrl)
    setCopied('url')
    setTimeout(() => setCopied(null), 2000)
  }, [shareableUrl])

  const handleCopyToken = useCallback(() => {
    if (!token) return
    navigator.clipboard.writeText(token)
    setCopied('token')
    setTimeout(() => setCopied(null), 2000)
  }, [token])

  const handleStop = useCallback(() => {
    stopTunnel.mutate()
    setShowPopover(false)
    setShowToken(false)
    setConfirmRegenerate(false)
  }, [stopTunnel])

  const handleRegenerate = useCallback(() => {
    regenerateTunnel.mutate(undefined, {
      onSuccess: () => {
        setConfirmRegenerate(false)
        setShowPopover(true)
      },
    })
  }, [regenerateTunnel])

  const closeButton = (
    <PopoverClose asChild>
      <IconButton size="xs" label={t('Close')} className="-mr-1 -mt-0.5 shrink-0">
        <X />
      </IconButton>
    </PopoverClose>
  )

  return (
    <Popover open={showPopover} onOpenChange={setShowPopover}>
      <div className="relative">
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isLoading}
            className={cn('p-1.5 rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60', tone.button)}
            title={t(tone.label)}
            aria-label={t(tone.label)}
          >
            {isLoading ? (
              <Spinner size="md" />
            ) : tone.icon === 'warn' ? (
              <AlertTriangle size={16} />
            ) : (
              <Smartphone size={16} />
            )}
          </button>
        </PopoverTrigger>
        {isActive && !isLoading && (
          <span className={`pointer-events-none absolute top-0.5 right-0.5 w-2 h-2 ${tone.dot} rounded-full`} />
        )}
      </div>

      <PopoverContent align="end" className={cn('max-w-[calc(100vw-1rem)]', isActive ? 'w-96' : 'w-80')}>
        {!isActive ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-foreground/80">
                  <Smartphone size={16} />
                </span>
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {t('Use Agent Tower on your phone')}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t('After enabling the tunnel, you can scan a QR code with your phone to visit this Agent Tower instance, assign tasks, and check agent status.')}
                  </p>
                </div>
              </div>
              {closeButton}
            </div>

            <Button variant="primary" size="sm" block className="mt-3" onClick={handleStart} loading={isLoading}>
              {isLoading ? t('Starting tunnel...') : t('Enable phone access')}
            </Button>
          </>
        ) : (
          <>
            <div className="mb-2 flex items-start justify-between gap-3">
              <div>
                <span className={cn('flex items-center gap-1.5 text-xs font-medium', statusInk)}>
                  <span className={`inline-block w-1.5 h-1.5 ${tone.dot} rounded-full`} />
                  {t(currentStatusText)}
                </span>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t(statusDescription(status))}
                </p>
              </div>
              {closeButton}
            </div>

            {token && (
              <div className="mb-2 flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs text-foreground/80">
                <Shield size={12} />
                <span>{t('Token protected')}</span>
              </div>
            )}

            {shareableUrl && (
              <div className="flex justify-center py-3">
                <QRCodeSVG value={shareableUrl} size={160} />
              </div>
            )}

            {shareableUrl || status?.url ? (
              <div className="flex items-center gap-2">
                <Input
                  size="sm"
                  readOnly
                  value={shareableUrl ?? status?.url ?? ''}
                  onFocus={e => e.target.select()}
                  aria-label={t('Copy shareable link')}
                  className="select-all text-xs"
                />
                <IconButton size="sm" label={t('Copy shareable link')} onClick={handleCopyUrl} disabled={!shareableUrl}>
                  {copied === 'url' ? <Check className="text-success" /> : <Copy />}
                </IconButton>
              </div>
            ) : (
              <div className="rounded-md border border-border bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
                {t('No tunnel link available')}
              </div>
            )}

            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md border border-border px-2 py-1.5">
                <div className="text-muted-foreground">{t('Last checked')}</div>
                <div className="mt-0.5 text-foreground">{relativeTime(status?.lastCheckedAt)}</div>
              </div>
              <div className="rounded-md border border-border px-2 py-1.5">
                <div className="text-muted-foreground">{t('Last healthy')}</div>
                <div className="mt-0.5 text-foreground">{relativeTime(status?.lastHealthyAt)}</div>
              </div>
            </div>

            {diagnostics && (
              <Notice tone="warning" size="sm" className="mt-2 max-h-28 overflow-auto">
                <div className="whitespace-pre-wrap break-words">{diagnostics}</div>
              </Notice>
            )}

            {status?.status === 'degraded' && (
              <Notice tone="warning" size="sm" className="mt-2">
                {t('Agent Tower is keeping the same URL and waiting for Cloudflare Quick Tunnel to recover.')}
              </Notice>
            )}

            {status?.status === 'linkReplaced' && (
              <Notice tone="warning" size="sm" className="mt-2">
                {t('The previous tunnel link and token are no longer valid.')}
              </Notice>
            )}

            {token && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {showToken ? t('Hide token') : t('Show token')}
                </button>
                {showToken && (
                  <div className="mt-1 flex items-center gap-2">
                    <code className="flex-1 min-w-0 break-all rounded-md border border-border bg-muted/50 px-2 py-1.5 text-xs text-foreground/80">
                      {token}
                    </code>
                    <IconButton size="sm" label={t('Copy token')} onClick={handleCopyToken} className="shrink-0">
                      {copied === 'token' ? <Check className="text-success" /> : <Copy />}
                    </IconButton>
                  </div>
                )}
              </div>
            )}

            {confirmRegenerate ? (
              <Notice tone="danger" size="sm" className="mt-3">
                {t('Generating a new link will invalidate the current link. People using the old URL must receive the new one.')}
                <div className="mt-2 flex gap-2">
                  <Button variant="secondary" size="xs" className="flex-1" onClick={() => setConfirmRegenerate(false)}>
                    {t('Cancel')}
                  </Button>
                  <Button variant="primary" tone="danger" size="xs" className="flex-1" onClick={handleRegenerate} loading={isRegenerating}>
                    {isRegenerating ? t('Generating...') : t('Regenerate link')}
                  </Button>
                </div>
              </Notice>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                block
                className="mt-3"
                onClick={() => setConfirmRegenerate(true)}
                disabled={isRegenerating || status?.canRegenerate === false}
              >
                <RefreshCw />
                {t('Regenerate link')}
              </Button>
            )}

            <Button variant="ghost" tone="danger" size="sm" block className="mt-1" onClick={handleStop} loading={stopTunnel.isPending}>
              {stopTunnel.isPending ? t('Stopping...') : t('Stop Tunnel')}
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
