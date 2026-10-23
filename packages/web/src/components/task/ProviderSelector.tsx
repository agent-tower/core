import { useId } from 'react'
import { ChevronDown } from 'lucide-react'
import { AgentLogo } from '@/components/agent'
import { Menu, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger, buttonClassName } from '@/design-system'
import { cn, truncateMiddle } from '@/lib/utils'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import { getProviderStartIssue, getSelectedProviderStartIssue } from '@/components/provider/provider-draft'
import { EXECUTION_PERMISSION_LABELS } from '@/components/provider/ExecutionPermissionSelector'
import { useI18n } from '@/lib/i18n'
import { RuntimeType } from '@agent-tower/shared'
import { isProviderEnabled } from '@/lib/provider-selection'

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
  const descriptionIdPrefix = useId()

  const effectiveRuntimeType = runtimeType === RuntimeType.ACP ? RuntimeType.ACP : RuntimeType.CLI
  // Session follow-up cannot switch Agent identity or Runtime.
  const filteredProviders = providers.filter(
    (p) => isProviderEnabled(p) && String(p.provider.agentType) === agentType
      && (p.provider.runtimeType === RuntimeType.ACP ? RuntimeType.ACP : RuntimeType.CLI) === effectiveRuntimeType
  )

  // 当前选中的 provider
  const currentProvider = providers.find(
    (p) => p.provider.id === currentProviderId
  )
  const currentName = currentProvider?.provider.name ? truncateMiddle(currentProvider.provider.name, 12) : agentType
  const currentIssue = getSelectedProviderStartIssue(providers, currentProviderId)
  const currentDetails = currentIssue ? (
    <span role="alert" className="block break-words text-xs leading-snug text-destructive-ink">
      {t(currentIssue)}
    </span>
  ) : null

  if (filteredProviders.length === 0 || (filteredProviders.length === 1 && filteredProviders[0].provider.id === currentProviderId)) {
    return (
      <div className="min-w-[112px] max-w-[min(46vw,240px)] px-2 py-1.5 text-xs text-muted-foreground select-none cursor-default">
        <div className="flex items-center gap-1">
          <AgentLogo agentType={currentProvider?.provider.agentType ?? agentType} className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{currentName}</span>
        </div>
        {currentDetails}
      </div>
    )
  }

  // 不能启动的渠道仍列出、可聚焦、读屏能读到原因，只是选不中
  const blockedIds = new Set(filteredProviders.filter(item => getProviderStartIssue(item)).map(item => item.provider.id))

  return (
    <div className="min-w-[112px] max-w-[min(46vw,240px)]">
      <Menu>
        <MenuTrigger
          className={buttonClassName({
            variant: 'ghost',
            size: 'sm',
            className: 'group max-w-full gap-1 px-2 text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
          })}
          title={`Provider: ${currentProvider?.provider.name ?? agentType} (click to change)`}
        >
          <AgentLogo agentType={currentProvider?.provider.agentType ?? agentType} className="size-3.5" />
          <span className="min-w-0 truncate">{currentName}</span>
          <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
        </MenuTrigger>
        <MenuContent side="top" align="end" className="max-h-[min(60vh,320px)] max-w-[min(80vw,320px)] overflow-y-auto">
          <MenuLabel>{t('切换渠道')}</MenuLabel>
          <MenuRadioGroup
            value={currentProviderId ?? ''}
            onValueChange={(providerId) => {
              if (!blockedIds.has(providerId)) onSelect(providerId)
            }}
          >
            {filteredProviders.map((item, index) => {
              const issue = getProviderStartIssue(item)
              const descriptionId = issue ? `${descriptionIdPrefix}-${index}` : undefined
              return (
                <MenuRadioItem
                  key={item.provider.id}
                  value={item.provider.id}
                  icon={<AgentLogo agentType={item.provider.agentType} className="mt-0.5 size-4" />}
                  aria-disabled={issue ? true : undefined}
                  aria-describedby={descriptionId}
                  // 单选项的选中无法靠 preventDefault 拦下（已在 onValueChange 里过滤），这里只让菜单保持打开
                  onSelect={issue ? (event) => event.preventDefault() : undefined}
                  className={cn('items-start', issue && 'cursor-not-allowed text-muted-foreground data-[highlighted]:text-muted-foreground')}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{item.provider.name}</span>
                    {item.provider.isDefault && (
                      <span className="shrink-0 text-xs font-normal text-muted-foreground">{t('(默认)')}</span>
                    )}
                  </span>
                  {item.provider.executionPermission ? (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {t(EXECUTION_PERMISSION_LABELS[item.provider.executionPermission])}
                    </span>
                  ) : null}
                  {issue ? (
                    <span id={descriptionId} className="block w-0 min-w-full whitespace-normal break-words text-xs font-normal text-destructive-ink">
                      {t(issue)}
                    </span>
                  ) : null}
                </MenuRadioItem>
              )
            })}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      {currentDetails ? <div className="px-2">{currentDetails}</div> : null}
    </div>
  )
}
