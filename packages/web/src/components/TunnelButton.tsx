import { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Globe, Loader2, Copy, Check, X } from 'lucide-react'
import { useTunnelStatus, useStartTunnel, useStopTunnel } from '@/hooks/use-tunnel'

export function TunnelButton() {
  const { data: status } = useTunnelStatus()
  const startTunnel = useStartTunnel()
  const stopTunnel = useStopTunnel()
  const [showPopover, setShowPopover] = useState(false)
  const [copied, setCopied] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [popoverPos, setPopoverPos] = useState({ top: 0, right: 0 })

  const isRunning = status?.running ?? false
  const isLoading = startTunnel.isPending

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

  const handleCopy = useCallback(() => {
    if (!status?.url) return
    navigator.clipboard.writeText(status.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [status?.url])

  const handleStop = useCallback(() => {
    stopTunnel.mutate()
    setShowPopover(false)
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
        title={isRunning ? 'Tunnel active' : 'Share via tunnel'}
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
                Tunnel Active
              </span>
              <button
                onClick={() => setShowPopover(false)}
                className="p-0.5 text-neutral-400 hover:text-neutral-600 rounded"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={status?.url ?? ''}
                className="flex-1 px-2 py-1.5 text-xs bg-neutral-50 border border-neutral-200 rounded-md text-neutral-700 select-all"
                onFocus={e => e.target.select()}
              />
              <button
                onClick={handleCopy}
                className="p-1.5 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors"
                title="Copy URL"
              >
                {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              </button>
            </div>
            <button
              onClick={handleStop}
              disabled={stopTunnel.isPending}
              className="mt-2 w-full px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-md transition-colors"
            >
              {stopTunnel.isPending ? 'Stopping...' : 'Stop Tunnel'}
            </button>
          </div>
        </>,
        document.body
      )}
    </div>
  )
}
