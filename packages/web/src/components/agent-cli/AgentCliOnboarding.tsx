import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, X } from 'lucide-react'
import { AgentCliEnvironmentPanel } from '@/components/agent-cli/AgentCliEnvironmentPanel'
import { hasAnyCoreAgentCli } from '@/components/agent-cli/agent-cli-utils'
import { useAgentCliStatus, useRefreshAgentCliStatus } from '@/hooks/use-agent-cli-environment'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { acquireScrollLock, releaseScrollLock } from '@/lib/scroll-lock'

const ONBOARDING_SKIP_KEY = 'agentCliEnvironmentOnboardingSkipped'

function isOnboardingSkipped(): boolean {
  if (typeof window === 'undefined') return true
  return window.localStorage.getItem(ONBOARDING_SKIP_KEY) === 'true'
}

function markOnboardingSkipped() {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ONBOARDING_SKIP_KEY, 'true')
}

export function AgentCliOnboarding() {
  const { t } = useI18n()
  const statusQuery = useAgentCliStatus()
  const refreshStatus = useRefreshAgentCliStatus()
  const [dismissed, setDismissed] = useState(isOnboardingSkipped)
  const refreshAttemptedRef = useRef(false)

  const visible = useMemo(() => {
    if (dismissed) return false
    const status = statusQuery.data
    if (!status || status.stale) return false
    return !hasAnyCoreAgentCli(status.tools)
  }, [dismissed, statusQuery.data])

  useEffect(() => {
    if (dismissed || refreshAttemptedRef.current || !statusQuery.data?.stale) return
    refreshAttemptedRef.current = true
    refreshStatus.mutate()
  }, [dismissed, refreshStatus, statusQuery.data?.stale])

  useEffect(() => {
    if (!visible) return
    acquireScrollLock()
    return () => releaseScrollLock()
  }, [visible])

  const handleSkip = () => {
    markOnboardingSkipped()
    setDismissed(true)
  }

  if (!visible) return null

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('Agent 环境引导')}
    >
      <div className="absolute inset-0 bg-black/25 backdrop-blur-sm" aria-hidden="true" />
      <div
        className={cn(
          'relative flex max-h-[calc(100vh-1.5rem)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl',
          'sm:max-h-[calc(100vh-3rem)]',
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border/60 bg-muted/30 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true">
              <Bot size={18} />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">{t('配置本机 Agent CLI')}</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t('当前没有检测到可用的 Codex、Claude Code 或 Cursor CLI。可以先完成安装，也可以稍后从设置里打开。')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleSkip}
            aria-label={t('跳过')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-5">
          <AgentCliEnvironmentPanel variant="onboarding" onSkip={handleSkip} />
        </div>
      </div>
    </div>
  )
}
