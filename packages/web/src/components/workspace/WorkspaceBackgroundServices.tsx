import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Clock3, Folder, RefreshCw, Server } from 'lucide-react'
import type {
  WorkspaceBackgroundServiceDto,
  WorkspaceBackgroundServiceRuntimeState,
} from '@agent-tower/shared'
import { Spinner } from '@/design-system'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { stripAnsiSequences } from '@/lib/ansi'
import {
  useWorkspaceBackgroundServiceLogs,
  useWorkspaceBackgroundServices,
} from '@/hooks/use-workspace-services'

const EMPTY_SERVICES: WorkspaceBackgroundServiceDto[] = []

interface WorkspaceBackgroundServicesProps {
  workspaceId: string
  enabled?: boolean
}

function formatCommand(service: WorkspaceBackgroundServiceDto) {
  return JSON.stringify([service.command, ...service.args])
}

function formatStartedAt(value: string | null, locale: string, fallback: string) {
  if (!value) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return fallback
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date)
}

function getStatusMeta(state: WorkspaceBackgroundServiceRuntimeState) {
  switch (state) {
    case 'RUNNING':
      return { label: 'Running', dotClassName: 'bg-terminal-green' }
    case 'STARTING':
      return { label: 'Starting', dotClassName: 'bg-terminal-yellow' }
    case 'STOPPING':
      return { label: 'Stopping', dotClassName: 'bg-terminal-yellow' }
    case 'FAILED':
      return { label: 'Failed', dotClassName: 'bg-terminal-red' }
    case 'EXITED':
      return { label: 'Exited', dotClassName: 'bg-terminal-muted-foreground' }
    default:
      return { label: 'Stopped', dotClassName: 'bg-terminal-bright-black' }
  }
}

function StatusLabel({ state }: { state: WorkspaceBackgroundServiceRuntimeState }) {
  const { t } = useI18n()
  const status = getStatusMeta(state)
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-terminal-foreground">
      <span className={cn('h-1.5 w-1.5 rounded-full', status.dotClassName)} aria-hidden="true" />
      {t(status.label)}
    </span>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n()
  return (
    <div className="flex min-h-24 items-center justify-center gap-2 px-4 text-xs text-terminal-foreground" role="alert">
      <AlertTriangle size={14} className="shrink-0 text-terminal-red" aria-hidden="true" />
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-terminal-muted-foreground transition-colors hover:bg-terminal-accent hover:text-terminal-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-muted-foreground"
        title={t('Retry')}
        aria-label={t('Retry')}
      >
        <RefreshCw size={13} />
      </button>
    </div>
  )
}

export function WorkspaceBackgroundServices({
  workspaceId,
  enabled = true,
}: WorkspaceBackgroundServicesProps) {
  const { locale, t } = useI18n()
  const servicesQuery = useWorkspaceBackgroundServices(workspaceId, enabled)
  const services = servicesQuery.data ?? EMPTY_SERVICES
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const selectedService = services.find(service => service.name === selectedName) ?? services[0] ?? null
  const logsQuery = useWorkspaceBackgroundServiceLogs(
    workspaceId,
    selectedService?.name ?? '',
    selectedService?.runtimeInstanceId ?? null,
    enabled && !!selectedService,
  )
  const logText = useMemo(() => (
    stripAnsiSequences(logsQuery.data?.entries.map(entry => entry.data).join('') ?? '')
  ), [logsQuery.data?.entries])
  const logViewportRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    stickToBottomRef.current = true
  }, [selectedService?.id, selectedService?.runtimeInstanceId])

  useEffect(() => {
    const viewport = logViewportRef.current
    if (viewport && stickToBottomRef.current) viewport.scrollTop = viewport.scrollHeight
  }, [logText])

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-terminal text-terminal-foreground md:flex-row">
      <aside className="flex max-h-[44%] min-h-32 shrink-0 flex-col border-b border-terminal-border bg-terminal-chrome md:max-h-none md:min-h-0 md:w-72 md:border-b-0 md:border-r">
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-terminal-border px-3">
          <div className="flex min-w-0 items-center gap-2">
            <Server size={13} className="shrink-0 text-terminal-muted-foreground" aria-hidden="true" />
            <h2 className="truncate text-xs font-medium">{t('Background services')}</h2>
          </div>
          {!servicesQuery.isLoading && !servicesQuery.isError && (
            <span className="text-[11px] tabular-nums text-terminal-muted-foreground">{services.length}</span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-app-thin">
          {servicesQuery.isLoading ? (
            <div className="flex min-h-24 items-center justify-center gap-2 text-xs text-terminal-muted-foreground">
              <Spinner size="sm" />
              {t('Loading background services...')}
            </div>
          ) : servicesQuery.isError ? (
            <ErrorState
              message={t('Failed to load background services.')}
              onRetry={() => void servicesQuery.refetch()}
            />
          ) : services.length === 0 ? (
            <div className="flex min-h-24 flex-col items-center justify-center gap-2 px-4 text-center text-xs text-terminal-muted-foreground">
              <Server size={22} aria-hidden="true" />
              <span>{t('No background services')}</span>
            </div>
          ) : (
            services.map(service => {
              const selected = service.name === selectedService?.name
              return (
                <button
                  key={service.id}
                  type="button"
                  onClick={() => setSelectedName(service.name)}
                  aria-pressed={selected}
                  className={cn(
                    'block w-full border-b border-terminal-border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-terminal-muted-foreground',
                    // 选中的行与终端同底色，像「接」在右侧日志上
                    selected ? 'bg-terminal' : 'hover:bg-terminal-accent',
                  )}
                >
                  <span className="flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-terminal-foreground">{service.name}</span>
                    <StatusLabel state={service.runtimeState} />
                  </span>
                  <span className="mt-1 block truncate font-mono text-[11px] text-terminal-muted-foreground" title={formatCommand(service)}>
                    {formatCommand(service)}
                  </span>
                  <span className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-terminal-muted-foreground">
                    <Folder size={10} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">{service.relativeCwd || '.'}</span>
                  </span>
                  {/* 时间用 11px 数字字号；「未启动」是中文，按 12px */}
                  <span className={`mt-1 flex min-w-0 items-center gap-1 ${service.startedAt ? 'text-[11px]' : 'text-xs'} text-terminal-muted-foreground`}>
                    <Clock3 size={10} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      {formatStartedAt(service.startedAt, locale, t('Not started'))}
                    </span>
                  </span>
                </button>
              )
            })
          )}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-terminal" aria-label={t('Background service logs')}>
        {selectedService ? (
          <>
            <header className="shrink-0 border-b border-terminal-border bg-terminal-chrome">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2">
                <span className="min-w-0 truncate text-xs font-semibold text-terminal-foreground">
                  {selectedService.name}
                </span>
                <StatusLabel state={selectedService.runtimeState} />
              </div>
              <div
                className="max-h-32 overflow-y-auto overscroll-y-contain px-3 pb-2 scrollbar-app-thin focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-terminal-muted-foreground"
                tabIndex={0}
                aria-label={`${selectedService.name} ${t('Details')}`}
              >
                <dl className="mt-1.5 grid min-w-0 gap-x-4 gap-y-1 text-xs text-terminal-muted-foreground sm:grid-cols-2">
                  <div className="flex min-w-0 gap-1.5">
                    <dt className="shrink-0">{t('Command')}:</dt>
                    <dd className="min-w-0 break-all font-mono text-terminal-foreground">{formatCommand(selectedService)}</dd>
                  </div>
                  <div className="flex min-w-0 gap-1.5">
                    <dt className="shrink-0">{t('Working directory')}:</dt>
                    <dd className="min-w-0 break-all font-mono text-terminal-foreground">{selectedService.relativeCwd || '.'}</dd>
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5 sm:col-span-2">
                    <Clock3 size={10} className="shrink-0" aria-hidden="true" />
                    <dt className="shrink-0">{t('Started')}:</dt>
                    <dd className="truncate text-terminal-foreground">
                      {formatStartedAt(selectedService.startedAt, locale, t('Not started'))}
                    </dd>
                  </div>
                </dl>
                {selectedService.lastError && (
                  <p className="mt-1.5 flex min-w-0 items-start gap-1.5 break-words text-xs text-terminal-foreground" role="alert">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0 text-terminal-red" aria-hidden="true" />
                    <span className="min-w-0">{selectedService.lastError}</span>
                  </p>
                )}
              </div>
            </header>

            {(logsQuery.data?.truncated || logsQuery.data?.reset) && (
              <div className="shrink-0 border-b border-terminal-yellow/20 bg-terminal-yellow/10 px-3 py-1.5 text-xs text-terminal-foreground">
                {t('Earlier log output is unavailable.')}
              </div>
            )}
            {logsQuery.isError && (
              <div className="flex shrink-0 items-center gap-2 border-b border-terminal-red/20 bg-terminal-red/10 px-3 py-1.5 text-xs text-terminal-foreground" role="alert">
                <span>{t('Failed to refresh service logs.')}</span>
                <button
                  type="button"
                  onClick={() => void logsQuery.refetch()}
                  className="flex h-6 w-6 items-center justify-center rounded text-terminal-foreground transition-colors hover:bg-terminal-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-muted-foreground"
                  title={t('Retry')}
                  aria-label={t('Retry')}
                >
                  <RefreshCw size={11} />
                </button>
              </div>
            )}

            <div
              ref={logViewportRef}
              onScroll={(event) => {
                const target = event.currentTarget
                stickToBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 32
              }}
              className="min-h-0 flex-1 overflow-auto p-3 scrollbar-app-thin"
              role="log"
              aria-live="off"
              tabIndex={0}
            >
              {logsQuery.isLoading && !logsQuery.data ? (
                <div className="flex h-full items-center justify-center gap-2 text-xs text-terminal-muted-foreground">
                  <Spinner size="sm" />
                  {t('Loading service logs...')}
                </div>
              ) : logText ? (
                <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-terminal-foreground">
                  {logText}
                </pre>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-terminal-muted-foreground">
                  {t('No logs yet')}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-terminal-muted-foreground">
            {servicesQuery.isLoading ? t('Loading background services...') : t('Select a background service')}
          </div>
        )}
      </section>
    </div>
  )
}
