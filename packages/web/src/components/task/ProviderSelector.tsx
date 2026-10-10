import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { AgentLogo } from '@/components/agent'
import { truncateMiddle } from '@/lib/utils'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import { getProviderStartIssue, getSelectedProviderStartIssue } from '@/components/provider/provider-draft'
import { EXECUTION_PERMISSION_LABELS } from '@/components/provider/ExecutionPermissionSelector'
import { useI18n } from '@/lib/i18n'
import { RuntimeType } from '@agent-tower/shared'

interface ProviderSelectorProps {
  providers: ProviderWithAvailability[]
  currentProviderId: string | null
  agentType: string
  runtimeType?: RuntimeType | string
  onSelect: (providerId: string) => void
}

export function ProviderSelector({
  providers,
  currentProviderId,
  agentType,
  runtimeType,
  onSelect,
}: ProviderSelectorProps) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const effectiveRuntimeType = runtimeType === RuntimeType.ACP ? RuntimeType.ACP : RuntimeType.CLI
  // Session follow-up cannot switch Agent identity or Runtime.
  const filteredProviders = providers.filter(
    (p) => String(p.provider.agentType) === agentType
      && (p.provider.runtimeType === RuntimeType.ACP ? RuntimeType.ACP : RuntimeType.CLI) === effectiveRuntimeType
  )

  // 当前选中的 provider
  const currentProvider = providers.find(
    (p) => p.provider.id === currentProviderId
  )
  const currentIssue = getSelectedProviderStartIssue(providers, currentProviderId)
  const currentDetails = currentIssue ? (
    <span role="alert" className="block break-words text-[11px] leading-snug text-destructive">
      {t(currentIssue)}
    </span>
  ) : null

  // 点击外部关闭下拉菜单
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  if (filteredProviders.length === 0 || (filteredProviders.length === 1 && filteredProviders[0].provider.id === currentProviderId)) {
    return (
      <div className="min-w-[112px] max-w-[min(46vw,240px)] px-2 py-1.5 text-xs text-neutral-400 select-none cursor-default">
        <div className="flex items-center gap-1">
          <AgentLogo agentType={currentProvider?.provider.agentType ?? agentType} className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{currentProvider?.provider.name ? truncateMiddle(currentProvider.provider.name, 12) : agentType}</span>
        </div>
        {currentDetails}
      </div>
    )
  }

  return (
    <div className="relative min-w-[112px] max-w-[min(46vw,240px)]" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex max-w-full items-center gap-1 text-xs px-2 py-1.5 rounded-lg transition-colors cursor-pointer hover:bg-neutral-100 text-neutral-400 hover:text-neutral-600"
        title={`Provider: ${currentProvider?.provider.name ?? agentType} (click to change)`}
      >
        <AgentLogo agentType={currentProvider?.provider.agentType ?? agentType} className="size-3.5" />
        <span className="min-w-0 truncate">{currentProvider?.provider.name ? truncateMiddle(currentProvider.provider.name, 12) : agentType}</span>
        <ChevronDown size={12} className={`shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {currentDetails ? <div className="px-2">{currentDetails}</div> : null}

      {isOpen && (
        <div className="absolute bottom-full right-0 z-50 mb-1 max-h-[min(60vh,320px)] min-w-[160px] max-w-[min(80vw,320px)] overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg">
          <div className="px-2 py-1 text-xs text-neutral-400 border-b border-neutral-100">
            {t('切换渠道')}
          </div>
          {filteredProviders.map((item) => {
            const issue = getProviderStartIssue(item)
            const permission = item.provider.executionPermission
              ? t('Required permission: {mode}', { mode: t(EXECUTION_PERMISSION_LABELS[item.provider.executionPermission]) })
              : undefined
            return (
              <div
                key={item.provider.id}
                tabIndex={issue ? 0 : undefined}
                role={issue ? 'group' : undefined}
                aria-label={issue ? [item.provider.name, permission, t(issue)].filter(Boolean).join(': ') : undefined}
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <button
                  type="button"
                  disabled={!!issue}
                  onClick={() => {
                    onSelect(item.provider.id)
                    setIsOpen(false)
                  }}
                  className={`disabled:cursor-not-allowed w-full flex items-center justify-between px-3 py-2 text-sm text-left hover:bg-neutral-50 transition-colors ${
                    item.provider.id === currentProviderId ? 'bg-blue-50 text-blue-600' : 'text-neutral-700'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <AgentLogo agentType={item.provider.agentType} className="size-4" />
                    <span className="min-w-0">
                      <span className="block truncate max-w-[200px]">{item.provider.name}</span>
                      {item.provider.executionPermission ? <span className="block text-xs">{t(EXECUTION_PERMISSION_LABELS[item.provider.executionPermission])}</span> : null}
                      {issue ? <span className="block max-w-[240px] break-words text-xs">{t(issue)}</span> : null}
                    </span>
                    {item.provider.isDefault && (
                      <span className="text-xs text-neutral-400">{t('(默认)')}</span>
                    )}
                  </span>
                  {item.provider.id === currentProviderId && (
                    <Check size={14} className="shrink-0" />
                  )}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
