// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageSelector } from '../LanguageSelector'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { useUIStore } from '@/stores/ui-store'
import { getLayerCount } from '@/lib/scroll-lock'
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (value: string) => value, locale: 'en' }) }))
vi.mock('@/pages/TranslationSettingsPage', () => ({ TranslationSettingsPage: function Draft() {
  const [send, setSend] = useState('en-GB'), [display, setDisplay] = useState('Legacy custom dialect')
  return <><LanguageSelector id="send" value={send} onChange={setSend} /><LanguageSelector id="display" value={display} onChange={setDisplay} /></>
} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) }) }
afterEach(() => { if (root) act(() => root!.unmount()); useUIStore.setState({ settingsOpen: false }); document.body.replaceChildren() })
it.each(['send', 'display'])('keeps the real settings dialog and both draft fields on %s dropdown Escape', async id => {
  useUIStore.getState().openSettings('translation')
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  act(() => root!.render(<SettingsDialog />)); await flush(); await flush()
  expect(getLayerCount()).toBe(1)
  const trigger = document.getElementById(id) as HTMLButtonElement
  act(() => trigger.click()); await flush()
  expect(getLayerCount()).toBe(2)
  expect(document.querySelector('[role="listbox"]')).not.toBeNull()
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await flush()
  expect(useUIStore.getState().settingsOpen).toBe(true)
  expect(document.querySelector('[role="listbox"]')).toBeNull()
  expect(document.getElementById('send')?.textContent).toContain('en-GB')
  expect(document.getElementById('display')?.textContent).toContain('Legacy custom dialect')
  expect(document.activeElement).toBe(trigger)
  expect(getLayerCount()).toBe(1)
  act(() => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await flush()
  expect(useUIStore.getState().settingsOpen).toBe(false)
  expect(getLayerCount()).toBe(0)
})
