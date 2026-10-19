import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe2, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { IconButton, Input, Spinner } from '@/design-system'
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
import { agentVisualizationUrl } from '@/lib/message-intent'

interface PreviewPanelProps {
  workspaceId?: string
  readOnly?: boolean
  navigationRequest?: PreviewOpenRequest
  onNavigationRequestHandled?: (requestId: number) => void
}

export type PreviewSource =
  | { kind: 'web'; url: string }
  | { kind: 'visualization'; sessionId: string; file: string }

export interface PreviewOpenRequest {
  id: number
  source: PreviewSource
  workspaceId?: string
}

interface PreviewBrowserState {
  target: string | null
  address: string
  iframeSrc: string | null
  isFrameLoading: boolean
}

interface VisualizationBrowserState {
  source: Extract<PreviewSource, { kind: 'visualization' }>
  iframeSrc: string
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
  const [visualization, setVisualization] = useState<VisualizationBrowserState | null>(null)
  const visualizationRequested = navigationRequest?.source.kind === 'visualization'
  const webPreviewEnabled = !visualizationRequested && !visualization
  const { data: status, isLoading, refetch, isFetching } = usePreviewStatus(workspaceId, webPreviewEnabled)
  const updateConfig = useUpdatePreviewConfig(workspaceId)
  const {
    session: previewSession,
    isOpening: isSessionOpening,
    error: sessionError,
    retry: retrySession,
  } = usePreviewSession(workspaceId, status, webPreviewEnabled)
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
      const requestedNavigation = navigationRequest?.source.kind === 'web'
        && handledNavigationRequestRef.current !== navigationRequest.id
        ? resolvePreviewNavigation(
            navigationRequest.source.url,
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
          ? navigationRequest?.source.kind === 'web'
            ? navigationRequest.source.url
            : current.address
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
    setVisualization(null)

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
    if (!navigationRequest) return
    if (handledNavigationRequestRef.current === navigationRequest.id) return
    if (navigationRequest.source.kind === 'web' && isLoading) return
    const timer = window.setTimeout(() => {
      handledNavigationRequestRef.current = navigationRequest.id
      onNavigationRequestHandled?.(navigationRequest.id)
      if (navigationRequest.source.kind === 'visualization') {
        setVisualization({
          source: navigationRequest.source,
          iframeSrc: agentVisualizationUrl(
            navigationRequest.source.sessionId,
            navigationRequest.source.file,
          ),
          isFrameLoading: true,
        })
        setIframeKey((key) => key + 1)
      } else {
        setVisualization(null)
        void navigateToAddress(navigationRequest.source.url)
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [isLoading, navigateToAddress, navigationRequest, onNavigationRequestHandled])

  useEffect(() => {
    if (visualization) return
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
  }, [browser.target, navigateToAddress, patchBrowserState, previewSession?.viewUrl, status?.target, visualization])

  const postPreviewAction = (action: 'back' | 'forward' | 'reload' | 'stop') => {
    iframeRef.current?.contentWindow?.postMessage({ source: PREVIEW_HOST_SOURCE, action }, '*')
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    void navigateToAddress(browser.address)
  }

  const handleRefresh = async () => {
    if (visualization) {
      setVisualization((current) => current ? { ...current, isFrameLoading: true } : current)
      setIframeKey((key) => key + 1)
      return
    }

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
    if (visualization) {
      window.open(visualization.iframeSrc, '_blank', 'noopener,noreferrer')
      return
    }
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
      <div className="h-full flex items-center justify-center bg-background text-sm text-muted-foreground">
        {t('No active workspace.')}
      </div>
    )
  }

  const activeIframeSrc = visualization?.iframeSrc ?? browser.iframeSrc
  const isVisualizationMode = Boolean(visualization)
  const busy = !isVisualizationMode && (isLoading || isFetching || updateConfig.isPending || isSessionOpening)

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="shrink-0 border-b border-border bg-muted/40 px-2 py-2">
        <div className="flex items-center gap-1">
          <IconButton
            label={t('Back')}
            onClick={() => {
              if (isVisualizationMode) {
                setVisualization(null)
              } else {
                postPreviewAction('back')
              }
            }}
            disabled={!isVisualizationMode && !browser.iframeSrc}
          >
            <ArrowLeft />
          </IconButton>
          <IconButton
            label={t('Forward')}
            onClick={() => postPreviewAction('forward')}
            disabled={isVisualizationMode || !browser.iframeSrc}
          >
            <ArrowRight />
          </IconButton>
          <IconButton
            label={!isVisualizationMode && browser.isFrameLoading ? t('Stop loading') : t('Refresh preview')}
            onClick={!isVisualizationMode && browser.isFrameLoading
              ? () => {
                  postPreviewAction('stop')
                  patchBrowserState({ isFrameLoading: false })
                }
              : handleRefresh}
            disabled={!isVisualizationMode && !browser.isFrameLoading && isFetching}
          >
            {!isVisualizationMode && browser.isFrameLoading ? <X /> : isFetching ? <Spinner /> : <RefreshCw />}
          </IconButton>

          <form className="min-w-0 flex-1" onSubmit={handleSubmit}>
            <Input
              ref={addressInputRef}
              size="sm"
              prefix={<Globe2 />}
              value={visualization?.source.file ?? browser.address}
              onChange={(event) => patchBrowserState({ address: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
              }}
              disabled={isVisualizationMode || readOnly || updateConfig.isPending}
              placeholder={formatHint()}
              aria-label={t('Preview address')}
            />
          </form>

          <IconButton
            label={t('Open preview in new tab')}
            onClick={handleOpenInNewTab}
            disabled={!activeIframeSrc}
          >
            <ExternalLink />
          </IconButton>
        </div>

        <div className="mt-1 flex min-h-4 items-center justify-between gap-2 px-1 text-xs leading-4">
          <span className="truncate text-muted-foreground">
            {isVisualizationMode
              ? t('Viewing agent visualization')
              : busy
              ? t('Checking preview target...')
              : sessionError
                ? sessionError.message
                : status?.ready
                  ? `${t('Proxying')} ${status.target}`
                  : status?.configured
                    ? `${t('Preview target is not reachable')}${status.error ? `: ${status.error}` : ''}`
                    : t('Enter a local preview URL on the Agent Tower machine.')}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {isVisualizationMode ? t('Session file') : t('Loopback only')}
          </span>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 bg-background">
        {activeIframeSrc ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={activeIframeSrc}
            title={t('Preview')}
            // ds-allow black-white: 网页默认画布是白色，深色主题下也保持白底，与浏览器里看到的一致
            className="absolute inset-0 h-full w-full border-0 bg-white"
            sandbox={isVisualizationMode
              ? 'allow-modals allow-pointer-lock allow-presentation allow-scripts'
              : 'allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts'}
            allow="clipboard-read; clipboard-write; fullscreen"
            onLoad={() => {
              if (isVisualizationMode) {
                setVisualization((current) => current ? { ...current, isFrameLoading: false } : current)
              } else {
                patchBrowserState({ isFrameLoading: false })
              }
            }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-muted-foreground">
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
