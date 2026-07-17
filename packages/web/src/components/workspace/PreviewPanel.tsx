import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe2, Loader2, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  usePreviewSession,
  usePreviewStatus,
  useUpdatePreviewConfig,
} from '@/hooks/use-previews'
import { useI18n } from '@/lib/i18n'
import {
  buildPreviewProxyUrl,
  previewLocationToTarget,
  resolvePreviewNavigation,
} from '@/lib/preview-navigation'

interface PreviewPanelProps {
  workspaceId?: string
  readOnly?: boolean
  navigationRequest?: PreviewOpenRequest
  onNavigationRequestHandled?: (requestId: number) => void
}

export interface PreviewOpenRequest {
  id: number
  url: string
  workspaceId?: string
}

interface PreviewBrowserState {
  target: string | null
  address: string
  iframeSrc: string | null
  isFrameLoading: boolean
}

interface PreviewBridgeMessage {
  source?: unknown
  type?: unknown
  href?: unknown
  newTab?: unknown
}

const PREVIEW_BRIDGE_SOURCE = 'agent-tower-preview'
const PREVIEW_HOST_SOURCE = 'agent-tower-preview-host'

function formatHint() {
  return '3000, localhost:3000, http://127.0.0.1:5173'
}

function getOrigin(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export function PreviewPanel(props: PreviewPanelProps) {
  return <PreviewPanelContent key={props.workspaceId ?? 'no-workspace'} {...props} />
}

function PreviewPanelContent({
  workspaceId,
  readOnly,
  navigationRequest,
  onNavigationRequestHandled,
}: PreviewPanelProps) {
  const { t } = useI18n()
  const { data: status, isLoading, refetch, isFetching } = usePreviewStatus(workspaceId)
  const updateConfig = useUpdatePreviewConfig(workspaceId)
  const {
    session: previewSession,
    isOpening: isSessionOpening,
    error: sessionError,
    retry: retrySession,
  } = usePreviewSession(workspaceId, status)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const addressInputRef = useRef<HTMLInputElement | null>(null)
  const pendingPathRef = useRef<string | null>(null)
  const pendingPopupRef = useRef<Window | null>(null)
  const sessionOriginRef = useRef<string | null>(null)
  const handledNavigationRequestRef = useRef<number | null>(null)
  const [iframeKey, setIframeKey] = useState(0)
  const [browserState, setBrowser] = useState<PreviewBrowserState>({
    target: null,
    address: '',
    iframeSrc: null,
    isFrameLoading: false,
  })
  const sessionOrigin = getOrigin(previewSession?.viewUrl)
  const browser = status && browserState.target !== status.target
    ? {
        target: status.target,
        address: status.target ?? '',
        iframeSrc: null,
        isFrameLoading: false,
      }
    : status && !status.ready && browserState.iframeSrc
      ? { ...browserState, iframeSrc: null, isFrameLoading: false }
      : browserState

  const patchBrowserState = useCallback((patch: Partial<PreviewBrowserState>) => {
    setBrowser((current) => {
      const normalized = status && current.target !== status.target
        ? {
            target: status.target,
            address: status.target ?? '',
            iframeSrc: null,
            isFrameLoading: false,
          }
        : current
      return { ...normalized, ...patch }
    })
  }, [status])

  useEffect(() => {
    if (!previewSession || previewSession.target !== status?.target) return
    const originChanged = sessionOriginRef.current !== sessionOrigin
    sessionOriginRef.current = sessionOrigin

    setBrowser((current) => {
      const requestedNavigation = navigationRequest
        && handledNavigationRequestRef.current !== navigationRequest.id
        ? resolvePreviewNavigation(
            navigationRequest.url,
            previewSession.target,
            previewSession.viewUrl,
          )
        : null
      if (
        !originChanged
        && current.iframeSrc
        && current.target === previewSession.target
        && requestedNavigation?.kind !== 'proxy'
      ) return current
      let iframeSrc = current.iframeSrc
      if (requestedNavigation?.kind === 'proxy') {
        iframeSrc = requestedNavigation.url
      } else if (!iframeSrc || current.target !== previewSession.target || originChanged) {
        const pendingPath = pendingPathRef.current
        if (pendingPath) {
          iframeSrc = buildPreviewProxyUrl(previewSession.viewUrl, pendingPath)
        } else {
          const navigation = resolvePreviewNavigation(
            current.address || previewSession.target,
            previewSession.target,
            previewSession.viewUrl,
          )
          iframeSrc = navigation?.kind === 'proxy' ? navigation.url : previewSession.viewUrl
        }
      }
      pendingPathRef.current = null

      const popup = pendingPopupRef.current
      if (popup && !popup.closed && iframeSrc) popup.location.replace(iframeSrc)
      pendingPopupRef.current = null

      return {
        target: previewSession.target,
        address: requestedNavigation?.kind === 'proxy'
          ? navigationRequest?.url ?? current.address
          : current.address || previewSession.target,
        iframeSrc,
        isFrameLoading: Boolean(iframeSrc),
      }
    })
  }, [navigationRequest, previewSession, sessionOrigin, status?.target])

  useEffect(() => () => {
    pendingPopupRef.current?.close()
  }, [])

  const navigateToAddress = useCallback(async (value: string, openInNewTab = false) => {
    const navigation = resolvePreviewNavigation(
      value,
      status?.target ?? null,
      previewSession?.viewUrl ?? null,
    )
    if (!navigation || !workspaceId) return

    if (navigation.kind === 'proxy') {
      if (openInNewTab) {
        window.open(navigation.url, '_blank', 'noopener,noreferrer')
        return
      }
      setBrowser({
        target: status?.target ?? null,
        address: value,
        iframeSrc: navigation.url,
        isFrameLoading: true,
      })
      return
    }

    if (readOnly) return
    const popup = openInNewTab ? window.open('about:blank', '_blank') : null
    if (popup) popup.opener = null

    try {
      pendingPathRef.current = navigation.path
      pendingPopupRef.current = popup
      const updated = await updateConfig.mutateAsync(navigation.target)
      setBrowser({
        target: updated.target,
        address: value.trim(),
        iframeSrc: null,
        isFrameLoading: Boolean(updated.ready),
      })
      setIframeKey((key) => key + 1)
      toast.success(t('Preview target saved'))
      if (!updated.ready) {
        pendingPopupRef.current?.close()
        pendingPopupRef.current = null
      }
    } catch (err) {
      pendingPopupRef.current?.close()
      pendingPopupRef.current = null
      pendingPathRef.current = null
      const message = err instanceof Error ? err.message : t('Failed to save preview target')
      toast.error(message)
    }
  }, [previewSession?.viewUrl, readOnly, status?.target, t, updateConfig, workspaceId])

  useEffect(() => {
    if (!navigationRequest || isLoading) return
    if (handledNavigationRequestRef.current === navigationRequest.id) return
    const timer = window.setTimeout(() => {
      handledNavigationRequestRef.current = navigationRequest.id
      onNavigationRequestHandled?.(navigationRequest.id)
      void navigateToAddress(navigationRequest.url)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [isLoading, navigateToAddress, navigationRequest, onNavigationRequestHandled])

  useEffect(() => {
    const handleMessage = (event: MessageEvent<PreviewBridgeMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const message = event.data
      if (!message || message.source !== PREVIEW_BRIDGE_SOURCE) return

      if (message.type === 'location' && typeof message.href === 'string') {
        const nextAddress = previewLocationToTarget(
          status?.target ?? null,
          previewSession?.viewUrl ?? null,
          message.href,
          window.location.href,
        )
        if (nextAddress && document.activeElement !== addressInputRef.current) {
          patchBrowserState({
            target: status?.target ?? browser.target,
            address: nextAddress,
            isFrameLoading: false,
          })
        }
        return
      }

      if (message.type === 'navigate-loopback' && typeof message.href === 'string') {
        void navigateToAddress(message.href, message.newTab === true)
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [browser.target, navigateToAddress, patchBrowserState, previewSession?.viewUrl, status?.target])

  const postPreviewAction = (action: 'back' | 'forward' | 'reload' | 'stop') => {
    iframeRef.current?.contentWindow?.postMessage({ source: PREVIEW_HOST_SOURCE, action }, '*')
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    void navigateToAddress(browser.address)
  }

  const handleRefresh = async () => {
    const result = await refetch()
    if (!result.data?.ready) {
      patchBrowserState({
        target: result.data?.target ?? browser.target,
        iframeSrc: null,
        isFrameLoading: false,
      })
      return
    }

    if (!previewSession || !browser.iframeSrc) {
      retrySession()
      return
    }
    patchBrowserState({ isFrameLoading: true })
    postPreviewAction('reload')
  }

  const handleOpenInNewTab = () => {
    if (!previewSession?.viewUrl) return
    const navigation = resolvePreviewNavigation(
      browser.address || previewSession.target,
      previewSession.target,
      previewSession.viewUrl,
    )
    const url = navigation?.kind === 'proxy' ? navigation.url : previewSession.viewUrl
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  if (!workspaceId) {
    return (
      <div className="h-full flex items-center justify-center bg-white text-sm text-neutral-500">
        {t('No active workspace.')}
      </div>
    )
  }

  const busy = isLoading || isFetching || updateConfig.isPending || isSessionOpening

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="shrink-0 border-b border-neutral-200 bg-neutral-50 px-2 py-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => postPreviewAction('back')}
            disabled={!browser.iframeSrc}
            title={t('Back')}
            aria-label={t('Back')}
          >
            <ArrowLeft />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => postPreviewAction('forward')}
            disabled={!browser.iframeSrc}
            title={t('Forward')}
            aria-label={t('Forward')}
          >
            <ArrowRight />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={browser.isFrameLoading
              ? () => {
                  postPreviewAction('stop')
                  patchBrowserState({ isFrameLoading: false })
                }
              : handleRefresh}
            disabled={!browser.isFrameLoading && isFetching}
            title={browser.isFrameLoading ? t('Stop loading') : t('Refresh preview')}
            aria-label={browser.isFrameLoading ? t('Stop loading') : t('Refresh preview')}
          >
            {browser.isFrameLoading ? <X /> : isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>

          <form className="relative min-w-0 flex-1" onSubmit={handleSubmit}>
            <Globe2 className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-neutral-400" />
            <input
              ref={addressInputRef}
              value={browser.address}
              onChange={(event) => patchBrowserState({ address: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
              }}
              disabled={readOnly || updateConfig.isPending}
              placeholder={formatHint()}
              aria-label={t('Preview address')}
              className="h-8 w-full min-w-0 rounded-md border border-neutral-200 bg-white pl-8 pr-2.5 text-xs text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-neutral-400 disabled:bg-neutral-100 disabled:text-neutral-400"
            />
          </form>

          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={handleOpenInNewTab}
            disabled={!browser.iframeSrc}
            title={t('Open preview in new tab')}
            aria-label={t('Open preview in new tab')}
          >
            <ExternalLink />
          </Button>
        </div>

        <div className="mt-1 flex min-h-4 items-center justify-between gap-2 px-1 text-[11px] leading-4">
          <span className="truncate text-neutral-500">
            {busy
              ? t('Checking preview target...')
              : sessionError
                ? sessionError.message
                : status?.ready
                  ? `${t('Proxying')} ${status.target}`
                  : status?.configured
                    ? `${t('Preview target is not reachable')}${status.error ? `: ${status.error}` : ''}`
                    : t('Enter a local preview URL on the Agent Tower machine.')}
          </span>
          <span className="shrink-0 text-neutral-400">{t('Loopback only')}</span>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 bg-white">
        {browser.iframeSrc ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={browser.iframeSrc}
            title={t('Preview')}
            className="absolute inset-0 h-full w-full border-0 bg-white"
            sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts"
            allow="clipboard-read; clipboard-write; fullscreen"
            onLoad={() => patchBrowserState({ isFrameLoading: false })}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-neutral-500">
            {status?.configured
              ? status.ready && isSessionOpening
                ? t('Checking preview target...')
                : t('Start the preview server, then refresh.')
              : t('Configure a local preview target to display it here.')}
          </div>
        )}
      </div>
    </div>
  )
}
