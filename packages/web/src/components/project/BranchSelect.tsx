import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, GitBranch, Loader2 } from 'lucide-react'
import { Button, MENU_INDICATOR, MENU_ITEM, MENU_ITEM_CHECKABLE, Popover, PopoverContent, PopoverTrigger, SearchField } from '@/design-system'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface BranchSelectProps {
  id: string
  label: string
  value: string
  branches: string[]
  disabled?: boolean
  isRefreshing?: boolean
  onChange: (branch: string) => void
  onOpen: () => void
}

/** A searchable branch list composed from the design system's field and popover controls. */
export function BranchSelect({ id, label, value, branches, disabled, isRefreshing, onChange, onOpen }: BranchSelectProps) {
  const { t } = useI18n()
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const filteredBranches = branches.filter((branch) => branch.toLowerCase().includes(search.trim().toLowerCase()))
  const activeBranch = filteredBranches[activeIndex]
  const available = branches.includes(value)

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) {
      setSearch('')
      setActiveIndex(Math.max(0, branches.indexOf(value)))
      onOpen()
    }
  }

  const choose = (branch: string) => {
    onChange(branch)
    setOpen(false)
  }

  useEffect(() => {
    if (open) listRef.current?.querySelector('[data-highlighted]')?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex, search])

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => Math.max(0, Math.min(filteredBranches.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))))
    } else if (!search && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault()
      setActiveIndex(event.key === 'Home' ? 0 : Math.max(0, filteredBranches.length - 1))
    } else if (event.key === 'Enter' && activeBranch) {
      event.preventDefault()
      choose(activeBranch)
    }
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          aria-label={label}
          aria-haspopup="listbox"
          disabled={disabled}
          size="lg"
          title={value}
          className="w-full min-w-0 justify-between border border-input px-3 font-normal shadow-none ring-0 hover:border-ring/50 hover:bg-background focus-visible:border-ring focus-visible:ring-0 data-[state=open]:border-ring"
          onKeyDown={(event) => {
            if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              changeOpen(true)
            }
          }}
        >
          <GitBranch className="size-3.5 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left">{value}{!available && ` (${t('Unavailable')})`}</span>
          <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={label}
        className="z-[70] flex max-h-[min(24rem,var(--radix-popover-content-available-height))] w-(--radix-popover-trigger-width) max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-1"
        onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation() }}
        onEscapeKeyDown={(event) => {
          event.stopPropagation()
          if (search) {
            event.preventDefault()
            setSearch('')
            setActiveIndex(0)
          }
        }}
      >
        <div className="shrink-0 p-1">
          <SearchField
            aria-label={t('Search branches')}
            placeholder={t('Search branches')}
            role="combobox"
            aria-expanded
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={activeBranch ? `${listId}-${activeIndex}` : undefined}
            value={search}
            onValueChange={(query) => { setSearch(query); setActiveIndex(0) }}
            onKeyDown={handleSearchKeyDown}
          />
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label={label} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {filteredBranches.map((branch, index) => (
            <button
              key={branch}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={branch === value}
              data-highlighted={index === activeIndex ? '' : undefined}
              tabIndex={-1}
              title={branch}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => choose(branch)}
              className={cn(MENU_ITEM, MENU_ITEM_CHECKABLE, branch === value && 'font-medium text-foreground')}
            >
              <span className="min-w-0 flex-1 truncate">{branch}</span>
              {branch === value && <span className={MENU_INDICATOR}><Check className="size-3.5" /></span>}
            </button>
          ))}
          {filteredBranches.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">{t('No matching branches')}</p>}
        </div>
        <div role="status" className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-2 pt-2 pb-1 text-xs tabular-nums text-muted-foreground">
          {isRefreshing && <Loader2 className="size-3 animate-spin motion-reduce:[animation-duration:2.4s]" aria-label={t('Refreshing branches')} />}
          {search.trim() ? t('{shown} of {total} local branches', { shown: filteredBranches.length, total: branches.length }) : t('{count} local branches', { count: branches.length })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
