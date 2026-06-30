import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Download,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Square,
  Terminal,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  AgentCliInstallPreview,
  AgentCliInstallTask,
  AgentCliPublicInstallManifestItem,
  AgentCliToolId,
  AgentCliToolStatus,
} from '@agent-tower/shared'
import { ApiError } from '@/lib/api-client'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  useAgentCliInstallLogs,
  useAgentCliInstallTask,
  useAgentCliManifest,
  useAgentCliStatus,
  useCancelAgentCliInstallTask,
  useCreateAgentCliInstallPreview,
  useCreateAgentCliInstallTask,
  useRefreshAgentCliStatus,
} from '@/hooks/use-agent-cli-environment'
import {
  isInstallableAgentCliTool,
} from './agent-cli-utils'

const FINAL_TASK_STATUSES = new Set<AgentCliInstallTask['status']>([
  'succeeded',
  'failed',
  'cancelled',
])

const LOCAL_ONLY_CODE = 'AGENT_CLI_INSTALL_LOCAL_ONLY'
const EMPTY_MANIFEST: AgentCliPublicInstallManifestItem[] = []

function getApiErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined
  const code = error.details.code
  return typeof code === 'string' ? code : undefined
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && (error.status === 403 || getApiErrorCode(error) === LOCAL_ONLY_CODE)) {
    return '需要在本机 Agent Tower 打开后安装。'
  }
  return error instanceof Error ? error.message : fallback
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function formatPlatform(platform?: string): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  if (platform === 'win32') return 'Windows'
  return platform ?? 'Unknown'
}

function formatLogText(entries: Array<{ data: string }>): string {
  return entries
    .map(entry => entry.data.endsWith('\n') ? entry.data : `${entry.data}\n`)
    .join('')
}

function getStatusMeta(status?: AgentCliToolStatus) {
  switch (status?.installStatus) {
    case 'installed':
      return {
        label: '已安装',
        className: 'bg-success/10 text-success',
        icon: CheckCircle2,
      }
    case 'legacy_detected':
      return {
        label: 'Legacy 已检测',
        className: 'bg-warning/10 text-warning',
        icon: CheckCircle2,
      }
    case 'missing':
      return {
        label: '未安装',
        className: 'bg-muted text-muted-foreground',
        icon: XCircle,
      }
    case 'unsupported':
      return {
        label: '当前平台不支持',
        className: 'bg-muted text-muted-foreground',
        icon: AlertTriangle,
      }
    case 'error':
      return {
        label: '检测失败',
        className: 'bg-destructive/10 text-destructive',
        icon: AlertTriangle,
      }
    default:
      return {
        label: '未检测',
        className: 'bg-muted text-muted-foreground',
        icon: CircleDashed,
      }
  }
}

function getTaskStatusLabel(status?: AgentCliInstallTask['status']): string {
  switch (status) {
    case 'running':
      return '安装中'
    case 'verifying':
      return '验证中'
    case 'succeeded':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelling':
      return '取消中'
    case 'cancelled':
      return '已取消'
    default:
      return '未开始'
  }
}

function isCoreToolAvailable(status?: AgentCliToolStatus): boolean {
  return status?.installStatus === 'installed'
}

function StatusBadge({ status }: { status?: AgentCliToolStatus }) {
  const { t } = useI18n()
  const meta = getStatusMeta(status)
  const Icon = meta.icon
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', meta.className)}>
      <Icon size={11} aria-hidden="true" />
      {t(meta.label)}
    </span>
  )
}

function ToolRow({
  item,
  status,
  selected,
  disabled,
  onSelect,
  onPreview,
  previewing,
  previewDisabled,
}: {
  item: AgentCliPublicInstallManifestItem
  status?: AgentCliToolStatus
  selected: boolean
  disabled: boolean
  onSelect: () => void
  onPreview: () => void
  previewing: boolean
  previewDisabled: boolean
}) {
  const { t } = useI18n()
  const installable = item.install.kind === 'downloaded-script' && isInstallableAgentCliTool(item.id)
  const installed = isCoreToolAvailable(status)
  const unsupported = status?.installStatus === 'unsupported'

  return (
    <div
      className={cn(
        'rounded-lg border px-4 py-3 transition-colors',
        selected ? 'border-primary bg-muted/30' : 'border-border bg-background',
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{item.displayName}</span>
            <StatusBadge status={status} />
            {item.legacy && (
              <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                {t('迁移中')}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{item.description ?? t('Agent CLI 工具')}</span>
            {item.install.kind === 'detect-only' && <span>{item.install.reason}</span>}
            {status?.version && <span className="font-mono">v{status.version}</span>}
            {status?.authStatus === 'needs_interactive_login' && <span>{t('需要登录')}</span>}
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-2">
          {installable ? (
            <div className="flex flex-col items-start gap-1 sm:items-end">
              <Button
                size="sm"
                variant={installed ? 'outline' : 'default'}
                onClick={onPreview}
                disabled={disabled || previewDisabled || previewing || unsupported}
              >
                {previewing ? <Loader2 className="animate-spin" size={14} /> : <Download size={14} />}
                {installed ? t('重新预览') : t('预览安装')}
              </Button>
              {unsupported && (
                <span className="max-w-40 text-xs text-muted-foreground">
                  {t('当前平台不可安装。')}
                </span>
              )}
            </div>
          ) : (
            <Button size="sm" variant="outline" disabled>
              <Info size={14} />
              {t('只检测')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function PreviewPanel({
  preview,
  item,
  confirmed,
  onConfirmedChange,
  onInstall,
  installing,
  disabled,
}: {
  preview: AgentCliInstallPreview
  item?: AgentCliPublicInstallManifestItem
  confirmed: boolean
  onConfirmedChange: (confirmed: boolean) => void
  onInstall: () => void
  installing: boolean
  disabled: boolean
}) {
  const { t } = useI18n()

  return (
    <section className="rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex items-start gap-2.5">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{t('安装预览')}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('安装任务将使用后端 manifest 中的受控计划执行，前端只提交工具选择和预览 ID。')}
          </p>
        </div>
      </div>

      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t('平台')}</dt>
          <dd className="mt-1 font-medium text-foreground">{formatPlatform(preview.platform)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('脚本大小')}</dt>
          <dd className="mt-1 font-medium text-foreground">{formatBytes(preview.sizeBytes)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">{t('最终下载地址')}</dt>
          <dd className="mt-1 break-all font-mono text-[11px] text-foreground">{preview.finalUrl}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('解释器')}</dt>
          <dd className="mt-1 break-all font-mono text-[11px] text-foreground">
            {preview.interpreter.command}
            {preview.interpreter.args.length > 0 ? ` ${preview.interpreter.args.join(' ')}` : ''}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('固定参数')}</dt>
          <dd className="mt-1 break-all font-mono text-[11px] text-foreground">
            {preview.fixedArgs.length > 0 ? preview.fixedArgs.join(' ') : t('无')}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">SHA-256</dt>
          <dd className="mt-1 break-all font-mono text-[11px] text-foreground">{preview.sha256}</dd>
        </div>
      </dl>

      {item?.officialSources.length ? (
        <div className="mt-4">
          <div className="text-xs font-medium text-muted-foreground">{t('官方来源')}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {item.officialSources.map(source => (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted"
              >
                {source.label}
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            ))}
          </div>
        </div>
      ) : null}

      {preview.redirectChain.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-medium text-muted-foreground">{t('下载链路')}</div>
          <div className="mt-2 space-y-1 rounded-md bg-background px-3 py-2">
            {preview.redirectChain.map((step, index) => (
              <div key={`${step.url}-${index}`} className="flex items-start justify-between gap-3 text-[11px]">
                <span className="break-all text-foreground">{step.host}{step.path}</span>
                <span className="shrink-0 font-mono text-muted-foreground">{step.statusCode}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {preview.riskNotes.length > 0 && (
        <div className="mt-4 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-warning">
            <AlertTriangle size={13} aria-hidden="true" />
            {t('安装风险')}
          </div>
          <ul className="mt-2 space-y-1 text-xs leading-relaxed text-foreground">
            {preview.riskNotes.map(note => (
              <li key={note}>• {note}</li>
            ))}
          </ul>
        </div>
      )}

      <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-background px-3 py-2.5 text-xs leading-relaxed text-foreground">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => onConfirmedChange(event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border"
        />
        <span>{t('我已确认官方来源、下载摘要和风险说明。')}</span>
      </label>

      <div className="mt-4 flex justify-end">
        <Button onClick={onInstall} disabled={!confirmed || installing || disabled}>
          {installing ? <Loader2 className="animate-spin" size={14} /> : <Download size={14} />}
          {t('确认安装')}
        </Button>
      </div>
    </section>
  )
}

function TaskPanel({
  task,
  logs,
  onCancel,
  cancelling,
}: {
  task?: AgentCliInstallTask
  logs: string
  onCancel: () => void
  cancelling: boolean
}) {
  const { t } = useI18n()
  const active = task && !FINAL_TASK_STATUSES.has(task.status)
  const failed = task?.status === 'failed'
  const succeeded = task?.status === 'succeeded'

  return (
    <section className="rounded-lg border border-border bg-background p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          {active ? (
            <Loader2 className="animate-spin text-primary" size={16} aria-hidden="true" />
          ) : succeeded ? (
            <CheckCircle2 className="text-success" size={16} aria-hidden="true" />
          ) : failed ? (
            <XCircle className="text-destructive" size={16} aria-hidden="true" />
          ) : (
            <Terminal className="text-muted-foreground" size={16} aria-hidden="true" />
          )}
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t('安装任务')}</h3>
            <p className="text-xs text-muted-foreground">{t(getTaskStatusLabel(task?.status))}</p>
          </div>
        </div>
        {active && (
          <Button size="sm" variant="outline" onClick={onCancel} disabled={cancelling}>
            {cancelling ? <Loader2 className="animate-spin" size={14} /> : <Square size={14} />}
            {t('取消')}
          </Button>
        )}
      </div>

      {task?.errorMessage && (
        <div className="mt-3 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {task.errorMessage}
        </div>
      )}

      <pre className="mt-4 max-h-56 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-[11px] leading-relaxed text-foreground scrollbar-app-thin">
        {logs || t('等待安装日志...')}
      </pre>
    </section>
  )
}

export function AgentCliEnvironmentPanel({
  variant = 'settings',
  onSkip,
}: {
  variant?: 'settings' | 'onboarding'
  onSkip?: () => void
}) {
  const { t } = useI18n()
  const manifestQuery = useAgentCliManifest()
  const statusQuery = useAgentCliStatus()
  const refreshStatus = useRefreshAgentCliStatus()
  const createPreview = useCreateAgentCliInstallPreview()
  const createTask = useCreateAgentCliInstallTask()
  const cancelTask = useCancelAgentCliInstallTask()

  const [selectedToolId, setSelectedToolId] = useState<AgentCliToolId | null>(null)
  const [preview, setPreview] = useState<AgentCliInstallPreview | null>(null)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [inlineError, setInlineError] = useState<string | null>(null)
  const [pendingPreviewToolId, setPendingPreviewToolId] = useState<AgentCliToolId | null>(null)
  const autoRefreshAttemptedRef = useRef(false)
  const finalRefreshHandledRef = useRef<string | null>(null)
  const latestPreviewRequestRef = useRef(0)

  const taskQuery = useAgentCliInstallTask(activeTaskId)
  const task = activeTaskId
    ? taskQuery.data ?? (createTask.data?.task.id === activeTaskId ? createTask.data.task : undefined)
    : undefined
  const taskActive = task ? !FINAL_TASK_STATUSES.has(task.status) : false
  const logsQuery = useAgentCliInstallLogs(activeTaskId, !!activeTaskId && (taskActive || !task))

  const manifest = manifestQuery.data ?? EMPTY_MANIFEST
  const statusByToolId = useMemo(() => {
    return new Map((statusQuery.data?.tools ?? []).map(tool => [tool.toolId, tool]))
  }, [statusQuery.data])
  const defaultSelectedToolId = useMemo(() => {
    const firstMissingInstallable = manifest.find(item => (
      isInstallableAgentCliTool(item.id)
      && statusByToolId.get(item.id)?.installStatus !== 'installed'
    ))
    return (firstMissingInstallable ?? manifest[0])?.id ?? null
  }, [manifest, statusByToolId])
  const effectiveSelectedToolId = selectedToolId ?? defaultSelectedToolId

  const previewItem = preview
    ? manifest.find(item => item.id === preview.toolId) ?? null
    : null
  const installInProgress = !!task && !FINAL_TASK_STATUSES.has(task.status)
  const logs = formatLogText(logsQuery.data?.entries ?? [])

  const clearPreviewState = () => {
    setPreview(null)
    setConfirmed(false)
  }

  useEffect(() => {
    if (autoRefreshAttemptedRef.current) return
    if (!statusQuery.data?.stale) return
    autoRefreshAttemptedRef.current = true
    refreshStatus.mutate(undefined, {
      onError: (error) => {
        setInlineError(getErrorMessage(error, t('检测失败')))
      },
    })
  }, [refreshStatus, statusQuery.data?.stale, t])

  useEffect(() => {
    if (!task || !FINAL_TASK_STATUSES.has(task.status)) return
    if (finalRefreshHandledRef.current === task.id) return
    finalRefreshHandledRef.current = task.id
    void logsQuery.refetch()
    refreshStatus.mutate(undefined, {
      onError: (error) => {
        setInlineError(getErrorMessage(error, t('检测失败')))
      },
    })
  }, [logsQuery, refreshStatus, task, t])

  const handleRefresh = () => {
    setInlineError(null)
    refreshStatus.mutate(undefined, {
      onError: (error) => {
        const message = getErrorMessage(error, t('检测失败'))
        setInlineError(message)
        toast.error(message)
      },
    })
  }

  const handleSelectTool = (toolId: AgentCliToolId) => {
    latestPreviewRequestRef.current += 1
    setPendingPreviewToolId(null)
    setSelectedToolId(toolId)
    clearPreviewState()
    setInlineError(null)
  }

  const handlePreview = (toolId: AgentCliToolId) => {
    const requestId = latestPreviewRequestRef.current + 1
    latestPreviewRequestRef.current = requestId
    setSelectedToolId(toolId)
    setPendingPreviewToolId(toolId)
    clearPreviewState()
    setInlineError(null)
    createPreview.mutate(toolId, {
      onSuccess: (nextPreview) => {
        if (latestPreviewRequestRef.current !== requestId || nextPreview.toolId !== toolId) return
        setPreview(nextPreview)
        setConfirmed(false)
      },
      onError: (error) => {
        if (latestPreviewRequestRef.current !== requestId) return
        const message = getErrorMessage(error, t('创建安装预览失败'))
        setInlineError(message)
        toast.error(message)
      },
      onSettled: () => {
        if (latestPreviewRequestRef.current !== requestId) return
        setPendingPreviewToolId(null)
      },
    })
  }

  const handleInstall = () => {
    if (!preview || !previewItem || preview.toolId !== previewItem.id || !confirmed) {
      setConfirmed(false)
      setInlineError(t('安装预览已失效，请重新预览当前工具。'))
      return
    }
    setInlineError(null)
    createTask.mutate(preview.id, {
      onSuccess: (result) => {
        setActiveTaskId(result.task.id)
        setPreview(null)
        setConfirmed(false)
        toast.success(result.reused ? t('已有安装任务正在运行') : t('安装任务已启动'))
      },
      onError: (error) => {
        const message = getErrorMessage(error, t('启动安装失败'))
        setInlineError(message)
        toast.error(message)
      },
    })
  }

  const handleCancel = () => {
    if (!activeTaskId) return
    cancelTask.mutate(activeTaskId, {
      onError: (error) => {
        const message = getErrorMessage(error, t('取消安装失败'))
        setInlineError(message)
        toast.error(message)
      },
    })
  }

  const handleRetry = () => {
    if (!task?.toolId) return
    setActiveTaskId(null)
    finalRefreshHandledRef.current = null
    handlePreview(task.toolId)
  }

  if (manifestQuery.isLoading || statusQuery.isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-20 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    )
  }

  if (manifestQuery.isError || statusQuery.isError) {
    return (
      <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {t('Agent CLI 环境信息加载失败。')}
      </div>
    )
  }

  return (
    <div className={cn('space-y-5', variant === 'onboarding' && 'max-h-[min(72vh,720px)] overflow-y-auto pr-1 scrollbar-app-thin')}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-foreground">{t('Agent CLI 环境')}</h3>
            {statusQuery.data?.stale && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {t('状态待检测')}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('Codex、Claude Code 和 Cursor 可通过官方安装计划引导安装；Gemini CLI 首版只检测。')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onSkip && (
            <Button size="sm" variant="ghost" onClick={onSkip}>
              {t('跳过')}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={handleRefresh} disabled={refreshStatus.isPending}>
            <RefreshCw className={cn(refreshStatus.isPending && 'animate-spin')} size={14} />
            {t('重新检测')}
          </Button>
        </div>
      </div>

      {inlineError && (
        <div role="alert" className="rounded-lg border border-warning/25 bg-warning/10 px-4 py-3 text-sm text-foreground">
          <div className="flex items-start gap-2">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <span>{inlineError}</span>
          </div>
        </div>
      )}

      <div className="grid gap-3">
        {manifest.map(item => (
          <ToolRow
            key={item.id}
            item={item}
            status={statusByToolId.get(item.id)}
            selected={item.id === effectiveSelectedToolId}
            disabled={installInProgress}
            onSelect={() => handleSelectTool(item.id)}
            onPreview={() => handlePreview(item.id)}
            previewing={createPreview.isPending && pendingPreviewToolId === item.id}
            previewDisabled={createPreview.isPending}
          />
        ))}
      </div>

      {preview && previewItem && (
        <PreviewPanel
          preview={preview}
          item={previewItem}
          confirmed={confirmed}
          onConfirmedChange={setConfirmed}
          onInstall={handleInstall}
          installing={createTask.isPending}
          disabled={installInProgress}
        />
      )}

      {task && (
        <div className="space-y-3">
          <TaskPanel
            task={task}
            logs={logs}
            onCancel={handleCancel}
            cancelling={cancelTask.isPending}
          />
          {task.status === 'failed' && (
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={handleRetry} disabled={createPreview.isPending}>
                <RotateCcw size={14} />
                {t('重试')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
