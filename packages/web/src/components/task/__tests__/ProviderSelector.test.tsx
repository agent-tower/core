// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentType, RuntimeType } from '@agent-tower/shared'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import { ProviderSelector } from '../ProviderSelector'

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (source: string, params?: Record<string, string>) => source.replace(/\{(\w+)\}/g, (match, key: string) => params?.[key] ?? match) }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function provider(id: string, runtimeType: RuntimeType): ProviderWithAvailability {
  return {
    provider: {
      id,
      name: id,
      agentType: AgentType.CODEX,
      runtimeType,
      env: {},
      config: {},
      isDefault: false,
    },
    availability: { type: 'INSTALLATION_FOUND' },
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

/** 渠道菜单是设计系统的 Menu：按下鼠标打开，选项渲染在浮层（document.body）里 */
function openMenu(trigger: HTMLElement) {
  trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
}

function options() {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
}

function option(label: string) {
  return options().find(item => item.textContent?.includes(label))!
}

describe('ProviderSelector', () => {
  it('shows only the server reason when the only Provider is blocked', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const blocked = provider('blocked', RuntimeType.CLI)
    blocked.provider.executionPermission = 'AUTO_SANDBOX'
    blocked.provider.executionPermissionOptions = [{
      mode: 'AUTO_SANDBOX', supported: false, authorized: true, selectable: false,
      reasons: [{ code: 'CONFLICT', message: 'Sandbox no longer available' }],
    }]
    act(() => root.render(
      <ProviderSelector providers={[blocked]} currentProviderId="blocked"
        agentType={AgentType.CODEX} runtimeType={RuntimeType.CLI} onSelect={vi.fn()} />,
    ))
    expect(container.textContent).not.toContain('Required permission:')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Sandbox no longer available')
    expect(container.querySelector('button')).toBeNull()
    act(() => root.unmount())
  })

  it('keeps available Provider selectors to one row until the menu opens', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const ready = provider('ready', RuntimeType.CLI)
    ready.provider.executionPermission = 'ASK'
    const other = provider('other', RuntimeType.CLI)
    other.provider.executionPermission = 'AUTO_SANDBOX'

    act(() => root.render(
      <ProviderSelector providers={[ready]} currentProviderId="ready"
        agentType={AgentType.CODEX} runtimeType={RuntimeType.CLI} onSelect={vi.fn()} />,
    ))
    expect(container.textContent).not.toContain('Required permission:')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.firstElementChild?.children).toHaveLength(1)

    act(() => root.render(
      <ProviderSelector providers={[ready, other]} currentProviderId="ready"
        agentType={AgentType.CODEX} runtimeType={RuntimeType.CLI} onSelect={vi.fn()} />,
    ))
    expect(container.textContent).not.toContain('Required permission:')
    expect(container.firstElementChild?.children).toHaveLength(1)
    act(() => root.unmount())
  })

  it('allows choosing the sole remaining Provider when the former selection disappeared', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onSelect = vi.fn()
    act(() => root.render(
      <ProviderSelector providers={[provider('remaining', RuntimeType.CLI)]} currentProviderId="removed"
        agentType={AgentType.CODEX} runtimeType={RuntimeType.CLI} onSelect={onSelect} />,
    ))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Selected Provider is unavailable.')
    act(() => openMenu(container.querySelector('button')!))
    act(() => option('remaining').click())
    expect(onSelect).toHaveBeenCalledWith('remaining')
    act(() => root.unmount())
  })

  it('keeps an invalid Provider visible with its server reason and blocks switching', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onSelect = vi.fn()
    const blocked = provider('blocked', RuntimeType.ACP)
    blocked.provider.executionPermission = 'AUTO_SANDBOX'
    blocked.provider.executionPermissionOptions = [{
      mode: 'AUTO_SANDBOX', supported: false, authorized: true, selectable: false,
      reasons: [{ code: 'CONFLICT', message: 'Remove sandbox_workspace_write' }],
    }]
    act(() => root.render(
      <ProviderSelector providers={[provider('ready', RuntimeType.ACP), blocked]}
        currentProviderId="ready" agentType={AgentType.CODEX} runtimeType={RuntimeType.ACP} onSelect={onSelect} />,
    ))
    act(() => openMenu(container.querySelector<HTMLButtonElement>('button')!))
    const blockedOption = option('blocked')
    // 不能选的渠道仍可聚焦，原因通过 aria-describedby 交给读屏
    expect(blockedOption.getAttribute('aria-disabled')).toBe('true')
    expect(blockedOption.textContent).toContain('Remove sandbox_workspace_write')
    const description = document.getElementById(blockedOption.getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toContain('Remove sandbox_workspace_write')
    act(() => {
      blockedOption.focus()
      blockedOption.click()
      blockedOption.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(document.activeElement).toBe(blockedOption)
    expect(onSelect).not.toHaveBeenCalled()
    act(() => root.unmount())
  })

  it('only offers Providers matching the active Session runtime', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(
      <ProviderSelector
        providers={[
          provider('codex-cli', RuntimeType.CLI),
          provider('codex-acp-primary', RuntimeType.ACP),
          provider('codex-acp-secondary', RuntimeType.ACP),
        ]}
        currentProviderId="codex-acp-primary"
        agentType={AgentType.CODEX}
        runtimeType={RuntimeType.ACP}
        onSelect={vi.fn()}
      />,
    ))

    const trigger = document.querySelector('button')!
    act(() => openMenu(trigger))

    expect(document.body.textContent).toContain('codex-acp-primary')
    expect(document.body.textContent).toContain('codex-acp-secondary')
    expect(document.body.textContent).not.toContain('codex-cli')
    act(() => root.unmount())
  })

  it('keeps every same-type Codex ACP Provider selectable for a running ACP Session', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onSelect = vi.fn()
    act(() => root.render(
      <ProviderSelector
        providers={[
          provider('codex-cli', RuntimeType.CLI),
          provider('codex-acp-default', RuntimeType.ACP),
          provider('codex-acp-alpha', RuntimeType.ACP),
          provider('codex-acp-bravo', RuntimeType.ACP),
        ]}
        currentProviderId="codex-acp-alpha"
        agentType={AgentType.CODEX}
        runtimeType={RuntimeType.ACP}
        onSelect={onSelect}
      />,
    ))

    // ACP Session 必须渲染可点击下拉，而不是把切换入口退化成静态文本。
    const trigger = document.querySelector('button')
    expect(trigger).not.toBeNull()
    act(() => openMenu(trigger!))

    const optionLabels = () => options().map(item => item.textContent ?? '')

    expect(optionLabels().some(text => text.includes('codex-acp-default'))).toBe(true)
    expect(optionLabels().some(text => text.includes('codex-acp-alpha'))).toBe(true)
    expect(optionLabels().some(text => text.includes('codex-acp-bravo'))).toBe(true)
    expect(optionLabels().some(text => text.includes('codex-cli'))).toBe(false)

    act(() => option('codex-acp-bravo').click())
    expect(onSelect).toHaveBeenCalledWith('codex-acp-bravo')
    act(() => root.unmount())
  })
})
