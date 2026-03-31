import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCursorAgentModels } from '@/hooks/use-cursor-agent-models'
import { useI18n } from '@/lib/i18n'

interface CursorAgentModelFieldProps {
  value: string
  onChange: (value: string | undefined) => void
}

export function CursorAgentModelField({ value, onChange }: CursorAgentModelFieldProps) {
  const { t } = useI18n()
  const { data, isLoading, isError } = useCursorAgentModels()
  const models = data?.models ?? []
  const [listOpen, setListOpen] = useState(false)
  const [filter, setFilter] = useState('')

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return models
    return models.filter(
      m => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)
    )
  }, [models, filter])

  return (
    <div className="flex flex-col gap-2 flex-1 min-w-0">
      <input
        type="text"
        value={value}
        onChange={e => {
          const v = e.target.value
          onChange(v === '' ? undefined : v)
        }}
        placeholder={t('留空为 auto；或直接输入模型 ID（与 cursor-agent --model 一致）')}
        className="w-full px-3 py-1.5 text-sm border border-neutral-200 rounded focus:outline-none focus:ring-1 focus:ring-neutral-900 font-mono"
      />

      <button
        type="button"
        onClick={() => setListOpen(o => !o)}
        disabled={isLoading}
        className="flex items-center gap-1 text-xs text-neutral-600 hover:text-neutral-900 disabled:opacity-50 w-fit"
      >
        <ChevronDown size={14} className={cn('transition-transform', listOpen && 'rotate-180')} />
        {isLoading
          ? t('正在加载 cursor-agent 模型列表…')
          : listOpen
            ? t('收起列表')
            : t('从本机 cursor-agent 选择（{count} 个）', { count: models.length })}
      </button>

      {listOpen && !isLoading && (
        <div className="rounded-lg border border-neutral-200 bg-white shadow-sm overflow-hidden">
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder={t('筛选模型…')}
            className="w-full px-3 py-2 text-sm border-b border-neutral-100 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-neutral-300"
          />
          <div className="max-h-[min(50vh,22rem)] overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => {
                onChange(undefined)
                setListOpen(false)
                setFilter('')
              }}
              className={cn(
                'w-full px-3 py-2 text-left text-sm hover:bg-neutral-50',
                !value ? 'bg-neutral-50 font-medium' : 'text-neutral-700'
              )}
            >
              {t('默认 (auto)')}
            </button>
            {filtered.map(m => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onChange(m.id)
                  setListOpen(false)
                  setFilter('')
                }}
                className={cn(
                  'w-full px-3 py-2 text-left text-sm hover:bg-neutral-50 border-t border-neutral-100',
                  value === m.id ? 'bg-blue-50/80' : ''
                )}
              >
                <div className="font-mono text-xs text-neutral-900 break-all">{m.id}</div>
                <div className="text-xs text-neutral-500 mt-0.5 break-words">{m.label}</div>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-xs text-neutral-400 text-center">{t('无匹配项')}</div>
            )}
          </div>
        </div>
      )}

      {(isError || data?.error) && (
        <p className="text-xs text-amber-700">
          {t('无法从本机加载模型列表（{error}）。仍可手动输入；或在安装 cursor-agent 的机器上运行', {
            error: data?.error ?? t('请求失败'),
          })}
          <code className="mx-0.5 bg-neutral-100 px-1 rounded text-[11px]">cursor-agent --list-models</code>
          {t('查看 ID。')}
        </p>
      )}
    </div>
  )
}
