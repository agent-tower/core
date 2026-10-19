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
    <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ${
      packaged ? 'bg-success/10 text-success-ink' : 'bg-warning/10 text-warning-ink'
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
          <Loader2 className="h-5 w-5 animate-spin motion-reduce:[animation-duration:2.4s] text-muted-foreground" />
        </div>
      </SettingsPageContainer>
    )
  }

  if (isError || !data) {
    return (
      <SettingsPageContainer>
        <h2 className="mb-1 text-base font-semibold text-foreground">{t('MCP 配置')}</h2>
        <div className="mt-5 rounded-lg border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive-ink">
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
          <h2 className="text-base font-semibold text-foreground">{t('MCP 配置')}</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            {t('复制下面的 JSON 到支持 MCP 的客户端配置中。桌面打包版使用 App 内置 runtime，不需要全局安装 agent-tower。')}
          </p>
        </div>
        <Button size="sm" onClick={handleCopy}>
          <Copy size={14} />
          {t('复制配置')}
        </Button>
      </div>

      <div className="space-y-3 border-b border-border/60 pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <RuntimeBadge
            mode={data.runtimeMode}
            label={data.runtimeMode === 'desktop-packaged' ? t('桌面打包 runtime') : t('工作区 runtime')}
          />
          <span className="text-[12px] text-muted-foreground">
            {data.serverName}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border/60 bg-muted/35 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Terminal size={12} />
              Command
            </div>
            <div className="break-all font-mono text-[12px] leading-relaxed text-foreground">{data.command}</div>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/35 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Server size={12} />
              Entry
            </div>
            <div className="break-all font-mono text-[12px] leading-relaxed text-foreground">{data.args.at(-1) ?? ''}</div>
          </div>
        </div>
      </div>

      <div className="pt-5">
        <div className="mb-2 flex items-center justify-between">
          <label className="text-[12px] font-medium text-foreground/70">mcpServers JSON</label>
          {data.runtimeMode === 'desktop-packaged' && (
            <span className="inline-flex items-center gap-1 text-xs text-success-ink">
              <Check size={12} />
              {t('无需全局 CLI')}
            </span>
          )}
        </div>
        <textarea
          readOnly
          value={data.configJson}
          rows={14}
          className="w-full resize-y rounded-lg border border-border bg-foreground/[0.025] px-3 py-3 font-mono text-[12px] leading-relaxed text-foreground outline-none"
        />
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t('当前版本只生成通用 MCP 配置，不会自动修改 Claude、Codex 或其他第三方客户端配置文件。')}
        </p>
      </div>
    </SettingsPageContainer>
  )
}
