import { useId, useMemo, useState } from 'react'
import { Popover } from 'radix-ui'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import catalog from '@/lib/translation-languages.json'
import { useI18n } from '@/lib/i18n'
import { useScrollLock } from '@/lib/scroll-lock'

function languageOptions(locale: string) {
  const names = new Intl.DisplayNames([locale], { type: 'language' })
  const english = new Intl.DisplayNames(['en'], { type: 'language' })
  const byCode = new Map(catalog.languages.map(([code, name]) => [code, name]))
  for (const code of catalog.locales) if (code.includes('-')) byCode.set(code, english.of(code) ?? code)
  return [...byCode].map(([code, fallback]) => {
    const label = names.of(code)
    return { code, label: label && label !== code ? label : fallback, search: `${code} ${fallback} ${label ?? ''}`.toLocaleLowerCase() }
  }).sort((a, b) => a.label.localeCompare(b.label, locale))
}

export function LanguageSelector({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const { t, locale } = useI18n()
  const options = useMemo(() => languageOptions(locale ?? 'zh-CN'), [locale])
  const [open, setOpen] = useState(false)
  useScrollLock(open)
  const [search, setSearch] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const matches = useMemo(() => options.filter(option => option.search.includes(search.trim().toLocaleLowerCase())), [search, options])
  const visible = matches.slice(0, 100)
  const selected = options.find(option => option.code === value)
  const choose = (language: string) => { onChange(language); setOpen(false) }
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); setSearch(''); setActive(0) }}>
    <Popover.Trigger asChild><button id={id} type="button" role="combobox" aria-expanded={open} aria-controls={open ? listId : undefined} className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm">
      <span className="truncate">{selected ? `${selected.label} · ${selected.code}` : value}</span><ChevronsUpDown size={14} className="shrink-0 text-muted-foreground" />
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content align="start" sideOffset={5} collisionPadding={12}
      onEscapeKeyDown={event => event.stopPropagation()}
      className="z-[100] w-[min(26rem,calc(100vw-24px))] rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl">
      <div className="flex items-center gap-2 border-b border-border px-2 pb-2"><Search size={14} /><input autoFocus value={search} aria-label={t('Search languages')} aria-controls={listId} aria-activedescendant={visible[active] ? `${listId}-${active}` : undefined} onChange={event => { setSearch(event.target.value); setActive(0) }} placeholder={t('Search language or code…')} className="min-w-0 flex-1 bg-transparent text-sm outline-none" onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = Math.max(0, Math.min(visible.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))); setActive(next); document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: 'nearest' }) }
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && visible[active]) { event.preventDefault(); choose(visible[active].code) }
      }} /></div>
      <div id={listId} role="listbox" className="max-h-[min(45vh,20rem)] overflow-auto py-1">
        {!selected && value && <button type="button" role="option" aria-selected="true" className="w-full rounded px-2 py-2 text-left text-sm" onClick={() => choose(value)}>{t('Saved custom language')}: {value}</button>}
        {visible.map((option, index) => <button id={`${listId}-${index}`} key={option.code} type="button" role="option" aria-selected={value === option.code} className={`flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left text-sm ${index === active ? 'bg-accent' : 'hover:bg-accent'}`} onPointerMove={() => setActive(index)} onClick={() => choose(option.code)}><span>{option.label} <span className="text-xs text-muted-foreground">{option.code}</span></span>{value === option.code && <Check size={14} />}</button>)}
        {!matches.length && <p className="p-2 text-sm text-muted-foreground">{t('No matching languages')}</p>}
      </div>
      <p className="border-t border-border px-2 pt-2 text-xs text-muted-foreground">{t('Language matches: {count}. Search to narrow the list.', { count: matches.length })}</p>
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}
