import { useState, useRef, useEffect } from 'react'
import { Cpu, ChevronDown, Check } from 'lucide-react'
import { truncateMiddle } from '@/lib/utils'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import { useI18n } from '@/lib/i18n'

interface ProviderSelectorProps {
  providers: ProviderWithAvailability[]
  currentProviderId: string | null
  agentType: string
  onSelect: (providerId: string) => void
}

export function ProviderSelector({
  providers,
  currentProviderId,
  agentType,
  onSelect,
}: ProviderSelectorProps) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // 筛选同 agentType 的 providers
  const filteredProviders = providers.filter(
    (p) => String(p.provider.agentType) === agentType
  )

  // 当前选中的 provider
  const currentProvider = providers.find(
    (p) => p.provider.id === currentProviderId
  )

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

  if (filteredProviders.length <= 1) {
    // 如果只有一个或没有 provider，显示静态文本
    return (
      <div className="flex items-center gap-1 text-xs text-neutral-400 px-2 py-1.5 select-none cursor-default">
        <Cpu size={14} className="shrink-0" />
        <span>{currentProvider?.provider.name ? truncateMiddle(currentProvider.provider.name, 12) : agentType}</span>
      </div>
    )
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg transition-colors cursor-pointer hover:bg-neutral-100 text-neutral-400 hover:text-neutral-600"
        title={`Provider: ${currentProvider?.provider.name ?? agentType} (click to change)`}
      >
        <Cpu size={14} className="shrink-0" />
        <span>{currentProvider?.provider.name ? truncateMiddle(currentProvider.provider.name, 12) : agentType}</span>
        <ChevronDown size={12} className={`shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 mb-1 bg-white rounded-lg border border-neutral-200 shadow-lg py-1 min-w-[160px] z-50">
          <div className="px-2 py-1 text-xs text-neutral-400 border-b border-neutral-100">
            {t('切换渠道')}
          </div>
          {filteredProviders.map((item) => (
            <button
              key={item.provider.id}
              onClick={() => {
                onSelect(item.provider.id)
                setIsOpen(false)
              }}
              className={`w-full flex items-center justify-between px-3 py-2 text-sm text-left hover:bg-neutral-50 transition-colors ${
                item.provider.id === currentProviderId ? 'bg-blue-50 text-blue-600' : 'text-neutral-700'
              }`}
            >
                <span className="flex items-center gap-2">
                  <span className="truncate max-w-[120px]">{item.provider.name}</span>
                  {item.provider.isDefault && (
                  <span className="text-xs text-neutral-400">{t('(默认)')}</span>
                  )}
                </span>
              {item.provider.id === currentProviderId && (
                <Check size={14} className="shrink-0" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
