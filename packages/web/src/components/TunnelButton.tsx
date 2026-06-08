import { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Smartphone, Loader2, Copy, Check, X, Shield, RefreshCw, AlertTriangle } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useI18n } from '@/lib/i18n'
import { useTunnelStatus, useStartTunnel, useStopTunnel, useRegenerateTunnel, type TunnelStatus } from '@/hooks/use-tunnel'

function toneForStatus(status: TunnelStatus | undefined) {
  if (!status || status.status === 'stopped') {
    return {
      button: 'text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100',
      dot: '',
      label: 'Use Agent Tower on your phone',
      icon: 'idle' as const,
    }
  }

  switch (status.status) {
    case 'healthy':
    case 'checking':
      return {
        button: 'text-emerald-600 hover:bg-emerald-50',
        dot: 'bg-emerald-500',
        label: status.status === 'healthy' ? 'Tunnel healthy' : 'Checking tunnel health',
        icon: 'ok' as const,
      }
    case 'degraded':
    case 'localUnhealthy':
    case 'linkReplaced':
      return {
        button: 'text-amber-600 hover:bg-amber-50',
        dot: 'bg-amber-500',
        label: 'Tunnel needs attention',
        icon: 'warn' as const,
      }
    case 'exited':
    case 'error':
      return {
        button: 'text-red-600 hover:bg-red-50',
        dot: 'bg-red-500',
        label: 'Tunnel unavailable',
        icon: 'error' as const,
      }
    case 'starting':
      return {
        button: 'text-amber-600 hover:bg-amber-50',
        dot: 'bg-amber-500',
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
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [popoverPos, setPopoverPos] = useState({ top: 0, right: 0 })
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

  useEffect(() => {
    if (showPopover && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setPopoverPos({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      })
    }
  }, [showPopover])

  const handleToggle = useCallback(() => {
    if (isActive) {
      setShowPopover(true)
    } else {
      setShowPopover(true)
    }
  }, [isActive])

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

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={handleToggle}
        disabled={isLoading}
        className={`p-1.5 rounded-md transition-colors ${tone.button}`}
        title={t(tone.label)}
      >
        {isLoading ? (
          <Loader2 size={16} className="animate-spin" />
        ) : tone.icon === 'warn' ? (
          <AlertTriangle size={16} />
        ) : (
          <Smartphone size={16} />
        )}
      </button>

      {isActive && !isLoading && (
        <span className={`absolute top-0.5 right-0.5 w-2 h-2 ${tone.dot} rounded-full`} />
      )}

      {showPopover && !isActive && createPortal(
        <>
          <div className="fixed inset-0 z-[100]" onClick={() => setShowPopover(false)} />
          <div
            className="fixed z-[101] w-80 max-w-[calc(100vw-1rem)] bg-white rounded-lg shadow-lg border border-neutral-200 p-3"
            style={{ top: popoverPos.top, right: popoverPos.right }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex size-7 items-center justify-center rounded-md bg-neutral-100 text-neutral-700">
                  <Smartphone size={16} />
                </span>
                <div>
                  <div className="text-sm font-medium text-neutral-900">
                    {t('Use Agent Tower on your phone')}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                    {t('After enabling the tunnel, you can scan a QR code with your phone to visit this Agent Tower instance, assign tasks, and check agent status.')}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowPopover(false)}
                className="p-0.5 text-neutral-400 hover:text-neutral-600 rounded"
              >
                <X size={14} />
              </button>
            </div>

            <button
              onClick={handleStart}
              disabled={isLoading}
              className="mt-3 w-full px-3 py-2 text-xs font-medium text-white bg-neutral-900 hover:bg-neutral-800 rounded-md transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {isLoading && <Loader2 size={13} className="animate-spin" />}
              {isLoading ? t('Starting tunnel...') : t('Enable phone access')}
            </button>
          </div>
        </>,
        document.body
      )}

      {showPopover && isActive && createPortal(
        <>
          <div className="fixed inset-0 z-[100]" onClick={() => setShowPopover(false)} />
          <div
            className="fixed z-[101] w-96 max-w-[calc(100vw-1rem)] bg-white rounded-lg shadow-lg border border-neutral-200 p-3"
            style={{ top: popoverPos.top, right: popoverPos.right }}
          >
            <div className="flex items-start justify-between mb-2">
              <div>
                <span className={`text-xs font-medium flex items-center gap-1.5 ${
                  status?.status === 'healthy' || status?.status === 'checking'
                    ? 'text-emerald-600'
                    : status?.status === 'exited' || status?.status === 'error'
                      ? 'text-red-600'
                      : 'text-amber-600'
                }`}>
                  <span className={`w-1.5 h-1.5 ${tone.dot} rounded-full inline-block`} />
                  {t(currentStatusText)}
                </span>
                <p className="mt-1 text-xs text-neutral-500 leading-relaxed">
                  {t(statusDescription(status))}
                </p>
              </div>
              <button
                onClick={() => setShowPopover(false)}
                className="p-0.5 text-neutral-400 hover:text-neutral-600 rounded"
              >
                <X size={14} />
              </button>
            </div>

            {token && (
              <div className="flex items-center gap-1.5 mb-2 px-2 py-1 bg-neutral-50 rounded text-xs text-neutral-700">
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
                <input
                  readOnly
                  value={shareableUrl ?? status?.url ?? ''}
                  className="flex-1 min-w-0 px-2 py-1.5 text-xs bg-neutral-50 border border-neutral-200 rounded-md text-neutral-700 select-all"
                  onFocus={e => e.target.select()}
                />
                <button
                  onClick={handleCopyUrl}
                  disabled={!shareableUrl}
                  className="p-1.5 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors disabled:opacity-40"
                  title={t('Copy shareable link')}
                >
                  {copied === 'url' ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                </button>
              </div>
            ) : (
              <div className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-xs text-neutral-500">
                {t('No tunnel link available')}
              </div>
            )}

            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md border border-neutral-200 px-2 py-1.5">
                <div className="text-neutral-500">{t('Last checked')}</div>
                <div className="mt-0.5 text-neutral-800">{relativeTime(status?.lastCheckedAt)}</div>
              </div>
              <div className="rounded-md border border-neutral-200 px-2 py-1.5">
                <div className="text-neutral-500">{t('Last healthy')}</div>
                <div className="mt-0.5 text-neutral-800">{relativeTime(status?.lastHealthyAt)}</div>
              </div>
            </div>

            {diagnostics && (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800 whitespace-pre-wrap break-words max-h-28 overflow-auto">
                {diagnostics}
              </div>
            )}

            {status?.status === 'degraded' && (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                {t('Agent Tower is keeping the same URL and waiting for Cloudflare Quick Tunnel to recover.')}
              </div>
            )}

            {status?.status === 'linkReplaced' && (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                {t('The previous tunnel link and token are no longer valid.')}
              </div>
            )}

            {token && (
              <div className="mt-2">
                <button
                  onClick={() => setShowToken(!showToken)}
                  className="text-xs text-neutral-500 hover:text-neutral-700 transition-colors"
                >
                  {showToken ? t('Hide token') : t('Show token')}
                </button>
                {showToken && (
                  <div className="flex items-center gap-2 mt-1">
                    <code className="flex-1 min-w-0 px-2 py-1.5 text-xs bg-neutral-50 border border-neutral-200 rounded-md text-neutral-600 break-all">
                      {token}
                    </code>
                    <button
                      onClick={handleCopyToken}
                      className="p-1.5 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors shrink-0"
                      title={t('Copy token')}
                    >
                      {copied === 'token' ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                    </button>
                  </div>
                )}
              </div>
            )}

            {confirmRegenerate && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                <div>{t('Generating a new link will invalidate the current link. People using the old URL must receive the new one.')}</div>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => setConfirmRegenerate(false)}
                    className="flex-1 px-2 py-1 rounded-md bg-white text-neutral-700 border border-neutral-200 hover:bg-neutral-50"
                  >
                    {t('Cancel')}
                  </button>
                  <button
                    onClick={handleRegenerate}
                    disabled={isRegenerating}
                    className="flex-1 px-2 py-1 rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {isRegenerating ? t('Generating...') : t('Regenerate link')}
                  </button>
                </div>
              </div>
            )}

            {!confirmRegenerate && (
              <button
                onClick={() => setConfirmRegenerate(true)}
                disabled={isRegenerating || status?.canRegenerate === false}
                className="mt-3 w-full px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-50 rounded-md transition-colors disabled:opacity-40 flex items-center justify-center gap-1.5"
              >
                <RefreshCw size={13} />
                {t('Regenerate link')}
              </button>
            )}

            <button
              onClick={handleStop}
              disabled={stopTunnel.isPending}
              className="mt-2 w-full px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-md transition-colors"
            >
              {stopTunnel.isPending ? t('Stopping...') : t('Stop Tunnel')}
            </button>
          </div>
        </>,
        document.body
      )}
    </div>
  )
}
