import type { ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { useControllableState } from '../lib/hooks'
import { KbdGroup } from '../actions/kbd'
import { Input, type InputProps } from './input'

export interface SearchFieldProps extends Omit<InputProps, 'prefix' | 'suffix' | 'value' | 'defaultValue' | 'onChange' | 'type'> {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  /** 空值时右侧显示的快捷键，如 ['⌘', 'K'] */
  shortcut?: ReactNode[]
}

/** 搜索框：放大镜前缀；有内容时出现清除按钮，Esc 同样清空 */
export function SearchField({ value, defaultValue = '', onValueChange, shortcut, onKeyDown, ...props }: SearchFieldProps) {
  const { t } = useI18n()
  const [query, setQuery] = useControllableState({ value, defaultValue, onChange: onValueChange })

  return (
    <Input
      type="search"
      role="searchbox"
      value={query}
      onChange={event => setQuery(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Escape' && query) {
          event.preventDefault()
          setQuery('')
        }
        onKeyDown?.(event)
      }}
      prefix={<Search className="size-4 text-muted-foreground/70" />}
      suffix={query ? (
        <button
          type="button"
          onClick={() => setQuery('')}
          aria-label={t('Clear')}
          className="-mr-1 rounded p-0.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : shortcut ? <KbdGroup keys={shortcut} /> : undefined}
      className="[&::-webkit-search-cancel-button]:appearance-none"
      {...props}
    />
  )
}
