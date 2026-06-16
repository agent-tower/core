import { useCallback } from 'react'
import { toast } from 'sonner'
import { Check, Copy, Loader2, Server, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsPageContainer } from '@/components/settings/SettingsSection'
import { useMcpConfig } from '@/hooks/use-mcp-config'
import { useI18n } from '@/lib/i18n'

function RuntimeBadge({ mode, label }: { mode: string; label: string }) {
  const packaged = mode === 'desktop-packaged'
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-1 text-[11px] font-medium ${
      packaged ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
    }`}
    >
      {label}
    </span>
  )
}

export function McpSettingsPage() {
  const { t } = useI18n()
  const { data, isLoading, isError, refetch } = useMcpConfig()

  const handleCopy = useCallback(async () => {
    if (!data?.configJson) return
    try {
      await navigator.clipboard.writeText(data.configJson)
      toast.success(t('MCP 配置已复制'))
    } catch {
      toast.error(t('复制 MCP 配置失败'))
    }
  }, [data?.configJson, t])

  if (isLoading) {
    return (
      <SettingsPageContainer>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin text-neutral-500" />
        </div>
      </SettingsPageContainer>
    )
  }

  if (isError || !data) {
    return (
      <SettingsPageContainer>
        <h2 className="mb-1 text-base font-semibold text-neutral-900">{t('MCP 配置')}</h2>
        <div className="mt-5 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
          {t('MCP 配置加载失败')}
        </div>
        <Button className="mt-4" size="sm" variant="outline" onClick={() => void refetch()}>
          {t('重试')}
        </Button>
      </SettingsPageContainer>
    )
  }

  return (
    <SettingsPageContainer>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-neutral-900">{t('MCP 配置')}</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-neutral-500">
            {t('复制下面的 JSON 到支持 MCP 的客户端配置中。桌面打包版使用 App 内置 runtime，不需要全局安装 agent-tower。')}
          </p>
        </div>
        <Button size="sm" onClick={handleCopy}>
          <Copy size={14} />
          {t('复制配置')}
        </Button>
      </div>

      <div className="space-y-3 border-b border-neutral-100 pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <RuntimeBadge
            mode={data.runtimeMode}
            label={data.runtimeMode === 'desktop-packaged' ? t('桌面打包 runtime') : t('工作区 runtime')}
          />
          <span className="text-[12px] text-neutral-400">
            {data.serverName}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-neutral-100 bg-neutral-50/70 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase text-neutral-400">
              <Terminal size={12} />
              Command
            </div>
            <div className="break-all font-mono text-[12px] leading-relaxed text-neutral-800">{data.command}</div>
          </div>
          <div className="rounded-lg border border-neutral-100 bg-neutral-50/70 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase text-neutral-400">
              <Server size={12} />
              Entry
            </div>
            <div className="break-all font-mono text-[12px] leading-relaxed text-neutral-800">{data.args[0] ?? ''}</div>
          </div>
        </div>
      </div>

      <div className="pt-5">
        <div className="mb-2 flex items-center justify-between">
          <label className="text-[12px] font-medium text-neutral-600">mcpServers JSON</label>
          {data.runtimeMode === 'desktop-packaged' && (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600">
              <Check size={12} />
              {t('无需全局 CLI')}
            </span>
          )}
        </div>
        <textarea
          readOnly
          value={data.configJson}
          rows={14}
          className="w-full resize-y rounded-lg border border-neutral-200 bg-neutral-950 px-3 py-3 font-mono text-[12px] leading-relaxed text-neutral-100 outline-none"
        />
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
          {t('当前版本只生成通用 MCP 配置，不会自动修改 Claude、Codex 或其他第三方客户端配置文件。')}
        </p>
      </div>
    </SettingsPageContainer>
  )
}
