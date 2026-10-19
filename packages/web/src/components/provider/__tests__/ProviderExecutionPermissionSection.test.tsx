// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderExecutionPermissionSection } from '../ProviderExecutionPermissionSection'

let root: Root | undefined
let container: HTMLDivElement | undefined

function renderSection({ enabled = false, error = null }: { enabled?: boolean; error?: string | null } = {}) {
  const onToggle = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(
    <ProviderExecutionPermissionSection
      title="执行权限"
      label="跳过所有确认和沙盒"
      enabled={enabled}
      error={error}
      warning="Agent 将跳过确认并禁用沙盒保护。"
      enabledLabel="权限已开启"
      disabledLabel="权限已关闭"
      errorLabel="配置错误"
      onToggle={onToggle}
    />,
  ))
  return {
    onToggle,
    section: container.querySelector('section') as HTMLElement,
    toggle: container.querySelector('[role="switch"]') as HTMLButtonElement,
  }
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('ProviderExecutionPermissionSection', () => {
  it('renders the disabled state without warning or destructive treatment', () => {
    const { section, toggle } = renderSection()
    expect(section.dataset.state).toBe('disabled')
    expect(section.querySelector('[data-warning-icon]')).toBeNull()
    expect(section.querySelector('[role="alert"]')).toBeNull()
    expect(section.className).not.toContain('border-l-warning')
    expect(section.textContent).toContain('权限已关闭')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('uses icon, text, switch state, and a light warning boundary when enabled', () => {
    const { section, toggle } = renderSection({ enabled: true })
    expect(section.dataset.state).toBe('enabled')
    expect(section.querySelector('[data-warning-icon]')).not.toBeNull()
    expect(section.textContent).toContain('权限已开启')
    expect(section.textContent).toContain('Agent 将跳过确认并禁用沙盒保护。')
    expect(section.className).toContain('border-l-warning')
    expect(section.className).not.toContain('bg-warning')
    expect(section.className).not.toContain('destructive')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('keeps configuration errors destructive and disables the switch', () => {
    const message = '执行权限字段必须为 true 或 false，请在运行配置 JSON 中修正。'
    const { section, toggle } = renderSection({ error: message })
    const alert = section.querySelector('[role="alert"]') as HTMLElement
    expect(section.dataset.state).toBe('error')
    expect(alert.textContent).toBe(message)
    expect(alert.className).toContain('text-destructive')
    expect(section.textContent).toContain('配置错误')
    expect(toggle.disabled).toBe(true)
  })

  it('provides a 44px switch target and forwards changes', () => {
    const { onToggle, toggle } = renderSection()
    // 开关本身 20px 高，after 伪元素四周各扩 12px，触控热区 44px
    expect(toggle.className).toContain('h-5')
    expect(toggle.className).toContain('after:absolute')
    expect(toggle.className).toContain('after:-inset-3')
    act(() => toggle.click())
    expect(onToggle).toHaveBeenCalledWith(true)
  })
})
