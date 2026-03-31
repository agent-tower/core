import { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Globe, Loader2, Copy, Check, X, Shield } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useI18n } from '@/lib/i18n'
import { useTunnelStatus, useStartTunnel, useStopTunnel } from '@/hooks/use-tunnel'

export function TunnelButton() {
  const { t } = useI18n()
  const { data: status } = useTunnelStatus()
  const startTunnel = useStartTunnel()
  const stopTunnel = useStopTunnel()
  const [showPopover, setShowPopover] = useState(false)
  const [copied, setCopied] = useState<'url' | 'token' | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [popoverPos, setPopoverPos] = useState({ top: 0, right: 0 })
  const [showToken, setShowToken] = useState(false)

  const isRunning = status?.running ?? false
  const isLoading = startTunnel.isPending
  const shareableUrl = status?.shareableUrl
  const token = status?.token

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
    if (isRunning) {
      setShowPopover(true)
    } else {
      startTunnel.mutate(undefined, {
        onSuccess: () => setShowPopover(true),
      })
    }
  }, [isRunning, startTunnel])

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
  }, [stopTunnel])

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={handleToggle}
        disabled={isLoading}
        className={`p-1.5 rounded-md transition-colors ${
          isRunning
            ? 'text-emerald-600 hover:bg-emerald-50'
            : 'text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100'
        }`}
        title={isRunning ? t('Tunnel active') : t('Share via tunnel')}
      >
        {isLoading ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Globe size={16} />
        )}
      </button>

      {/* 运行中的小绿点 */}
      {isRunning && !isLoading && (
        <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-emerald-500 rounded-full" />
      )}

      {/* Portal popover — 脱离 header 的 stacking context */}
      {showPopover && isRunning && createPortal(
        <>
          <div className="fixed inset-0 z-[100]" onClick={() => setShowPopover(false)} />
          <div
            className="fixed z-[101] w-80 bg-white rounded-lg shadow-lg border border-neutral-200 p-3"
            style={{ top: popoverPos.top, right: popoverPos.right }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-emerald-600 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full inline-block" />
                {t('Tunnel Active')}
              </span>
              <button
                onClick={() => setShowPopover(false)}
                className="p-0.5 text-neutral-400 hover:text-neutral-600 rounded"
              >
                <X size={14} />
              </button>
            </div>

            {/* 安全提示 */}
            {token && (
              <div className="flex items-center gap-1.5 mb-2 px-2 py-1 bg-emerald-50 rounded text-xs text-emerald-700">
                <Shield size={12} />
                <span>{t('Token protected')}</span>
              </div>
            )}

            {/* QR 码（使用含 token 的分享链接） */}
            {shareableUrl && (
              <div className="flex justify-center py-3">
                <QRCodeSVG value={shareableUrl} size={160} />
              </div>
            )}

            {/* 分享链接（含 token） */}
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={shareableUrl ?? status?.url ?? ''}
                className="flex-1 px-2 py-1.5 text-xs bg-neutral-50 border border-neutral-200 rounded-md text-neutral-700 select-all"
                onFocus={e => e.target.select()}
              />
              <button
                onClick={handleCopyUrl}
                className="p-1.5 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors"
                title={t('Copy shareable link')}
              >
                {copied === 'url' ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              </button>
            </div>

            {/* Token 展开区域 */}
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
                    <code className="flex-1 px-2 py-1.5 text-xs bg-neutral-50 border border-neutral-200 rounded-md text-neutral-600 break-all">
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
