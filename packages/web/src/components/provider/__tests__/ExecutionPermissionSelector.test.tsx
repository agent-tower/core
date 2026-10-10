// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentType, type ExecutionPermissionOption } from '@agent-tower/shared'
import { ExecutionPermissionSelector } from '../ExecutionPermissionSelector'

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove() })

function openOptions() {
  const trigger = container!.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  act(() => trigger.click())
  return [...container!.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
}

describe('ExecutionPermissionSelector', () => {
  it('shows the Codex auto-review boundary while selected and in the option list', () => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    const options: ExecutionPermissionOption[] = [{ mode: 'AUTO_SANDBOX', supported: true, authorized: true, selectable: true, reasons: [] }]
    act(() => root!.render(<ExecutionPermissionSelector agentType={AgentType.CODEX} value="AUTO_SANDBOX" options={options} onChange={vi.fn()} />))
    expect(container.textContent).toContain('destructive deletions outside the workspace')
    expect(container.textContent).toContain('network access')
    expect(container.textContent).toContain('not guaranteed to prompt')
    expect(container.textContent).toContain('host or MCP tools')
    const [auto] = openOptions().filter(button => button.textContent?.includes('Auto approve (sandbox)'))
    expect(document.getElementById(auto!.getAttribute('aria-describedby')!)?.textContent).toContain('host or MCP tools')
  })
  it('keeps an invalid selected mode visible, disables activation and exposes a keyboard-readable reason', () => {
    const options: ExecutionPermissionOption[] = [
      { mode: 'ASK', supported: true, authorized: true, selectable: true, reasons: [] },
      { mode: 'AUTO_SANDBOX', supported: false, authorized: true, selectable: false, reasons: [{ code: 'CAPABILITY_UNVERIFIED', message: 'Sandbox not verified' }] },
      { mode: 'FULL_ACCESS', supported: true, authorized: false, selectable: false, reasons: [{ code: 'POLICY_MODE_DENIED', message: 'Full access denied' }] },
    ]
    const onChange = vi.fn()
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    act(() => root!.render(<ExecutionPermissionSelector value="FULL_ACCESS" options={options} error="Full access denied" onChange={onChange} />))
    expect(container.querySelectorAll('button')).toHaveLength(1)
    expect(container.querySelector('button')?.textContent).toContain('Auto approve (full access)')
    expect(container.textContent).toContain('Full access denied')
    const buttons = openOptions()
    expect(buttons).toHaveLength(3)
    expect(buttons.map(button => button.disabled)).toEqual([false, true, true])
    expect(buttons[2].getAttribute('aria-pressed')).toBe('true')
    act(() => { buttons[2].click(); buttons[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onChange).not.toHaveBeenCalled()
    const descriptionId = buttons[2].getAttribute('aria-describedby')!
    const description = document.getElementById(descriptionId)!
    const help = container.querySelector<HTMLElement>(`[role="group"][aria-describedby="${descriptionId}"]`)!
    expect(help.tabIndex).toBe(0)
    act(() => {
      help.focus()
      help.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(document.activeElement).toBe(help)
    expect(onChange).not.toHaveBeenCalled()
    expect(description.textContent).toContain('Full access denied')
    act(() => buttons[0].click())
    expect(onChange).toHaveBeenCalledWith('ASK')
    expect(container.querySelectorAll('button')).toHaveLength(1)
  })
  it('shows all three choices while support loads and blocks every choice', () => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    act(() => root!.render(<ExecutionPermissionSelector value="ASK" onChange={vi.fn()} />))
    const buttons = openOptions()
    expect(buttons.every(button => button.disabled)).toBe(true)
    expect(buttons).toHaveLength(3)
    expect(container.textContent).toContain('Loading permission support…')
  })
  it('allows explicit reselection of the current mode and closes without selection on Escape or outside click', () => {
    const onChange = vi.fn()
    const options: ExecutionPermissionOption[] = [
      { mode: 'ASK', supported: true, authorized: true, selectable: true, reasons: [] },
    ]
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    act(() => root!.render(<ExecutionPermissionSelector value="ASK" options={options} onChange={onChange} />))
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    const buttons = openOptions()
    act(() => buttons[0].click())
    expect(onChange).toHaveBeenCalledWith('ASK')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)

    openOptions()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    const parentKeyDown = vi.fn()
    document.body.addEventListener('keydown', parentKeyDown)
    act(() => trigger.dispatchEvent(escape))
    document.body.removeEventListener('keydown', parentKeyDown)
    expect(parentKeyDown).not.toHaveBeenCalled()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    openOptions()
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
