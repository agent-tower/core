import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { usePreviewStatus, useUpdatePreviewConfig } from '@/hooks/use-previews'
import { useI18n } from '@/lib/i18n'

interface PreviewPanelProps {
  workspaceId?: string
  readOnly?: boolean
}

function formatHint() {
  return '3000, localhost:3000, http://127.0.0.1:5173'
}

export function PreviewPanel({ workspaceId, readOnly }: PreviewPanelProps) {
  const { t } = useI18n()
  const { data: status, isLoading, refetch, isFetching } = usePreviewStatus(workspaceId)
  const updateConfig = useUpdatePreviewConfig(workspaceId)
  const [target, setTarget] = useState('')
  const [iframeKey, setIframeKey] = useState(0)

  useEffect(() => {
    setTarget(status?.target ?? '')
  }, [status?.target])

  const viewUrl = useMemo(() => {
    if (!status?.ready || !status.viewUrl) return null
    return `${status.viewUrl}?_=${iframeKey}`
  }, [iframeKey, status?.ready, status?.viewUrl])

  const handleSave = async () => {
    if (!workspaceId) return
    try {
      await updateConfig.mutateAsync(target.trim() || null)
      setIframeKey((key) => key + 1)
      toast.success(t('Preview target saved'))
    } catch (err) {
      const message = err instanceof Error ? err.message : t('Failed to save preview target')
      toast.error(message)
    }
  }

  const handleRefresh = async () => {
    await refetch()
    setIframeKey((key) => key + 1)
  }

  if (!workspaceId) {
    return (
      <div className="h-full flex items-center justify-center bg-white text-sm text-neutral-500">
        {t('No active workspace.')}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="shrink-0 border-b border-neutral-200 bg-neutral-50 px-3 py-2">
        <div className="flex items-center gap-2">
          <input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                handleSave()
              }
            }}
            disabled={readOnly || updateConfig.isPending}
            placeholder={formatHint()}
            className="h-8 min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2.5 text-xs text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-neutral-400 disabled:bg-neutral-100 disabled:text-neutral-400"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleSave}
            disabled={readOnly || updateConfig.isPending}
            title={t('Save preview target')}
          >
            {updateConfig.isPending ? <Loader2 className="animate-spin" /> : <Save />}
            <span className="hidden xl:inline">{t('Save')}</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleRefresh}
            disabled={isFetching}
            title={t('Refresh preview')}
          >
            {isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            <span className="hidden xl:inline">{t('Refresh')}</span>
          </Button>
          {status?.ready && status.viewUrl && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              asChild
              title={t('Open preview in new tab')}
            >
              <a href={status.viewUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink />
              </a>
            </Button>
          )}
        </div>
        <div className="mt-1 flex min-h-4 items-center justify-between gap-2 text-[11px] leading-4">
          <span className="truncate text-neutral-500">
            {isLoading
              ? t('Checking preview target...')
              : status?.ready
                ? `${t('Proxying')} ${status.target}`
                : status?.configured
                  ? `${t('Preview target is not reachable')}${status.error ? `: ${status.error}` : ''}`
                  : t('Enter a local preview URL on the Agent Tower machine.')}
          </span>
          <span className="shrink-0 text-neutral-400">
            {t('Loopback only')}
          </span>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 bg-white">
        {viewUrl ? (
          <iframe
            key={viewUrl}
            src={viewUrl}
            title={t('Preview')}
            className="absolute inset-0 h-full w-full border-0 bg-white"
            sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-neutral-500">
            {status?.configured
              ? t('Start the preview server, then refresh.')
              : t('Configure a local preview target to display it here.')}
          </div>
        )}
      </div>
    </div>
  )
}
