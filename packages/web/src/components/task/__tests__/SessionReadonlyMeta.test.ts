// @vitest-environment happy-dom
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentType, SessionStatus, type Session } from '@agent-tower/shared'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import { I18nProvider } from '@/lib/i18n'
import { getSessionTokenUsage, resolveSessionProviderDisplay, SessionReadonlyMeta } from '../SessionReadonlyMeta'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/hooks/use-app-settings', () => ({
  useAppSettings: () => ({ data: { locale: 'en' } }),
  useUpdateAppSettings: () => ({ mutate: vi.fn() }),
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
})

function session(input: Partial<Session>): Session {
  return {
    id: 'session-focused',
    workspaceId: 'workspace-1',
    agentType: AgentType.CODEX,
    status: SessionStatus.COMPLETED,
    providerId: 'codex-default',
    ...input,
  }
}

function provider(id: string, name: string): ProviderWithAvailability {
  return {
    provider: {
      id,
      name,
      agentType: AgentType.CODEX,
      env: {},
      config: {},
      isDefault: false,
    },
    availability: { type: 'INSTALLATION_FOUND' },
  }
}

describe('SessionReadonlyMeta helpers', () => {
  it('uses the focused/displayed session token usage as the initial value', () => {
    expect(getSessionTokenUsage(session({
      tokenUsage: { totalTokens: 42_000, modelContextWindow: 200_000 },
    }))).toEqual({
      totalTokens: 42_000,
      modelContextWindow: 200_000,
    })
  })

  it('resolves provider label from the focused/displayed session providerId', () => {
    expect(resolveSessionProviderDisplay(
      session({ providerId: 'provider-focused' }),
      [provider('provider-active', 'Active Provider'), provider('provider-focused', 'Focused Provider')],
    )).toEqual({
      label: 'Focused Provider',
      title: 'Focused Provider (provider-focused)',
    })
  })

  it('falls back to providerId when provider metadata is unavailable', () => {
    expect(resolveSessionProviderDisplay(session({ providerId: 'missing-provider' }), [])).toEqual({
      label: 'missing-provider',
      title: 'missing-provider',
    })
  })

  it('resolves provider label from fallback providerId when session metadata is unavailable', () => {
    expect(resolveSessionProviderDisplay(
      null,
      [provider('member-provider', 'Member Provider')],
      { providerId: 'member-provider', agentType: AgentType.CODEX },
    )).toEqual({
      label: 'Member Provider',
      title: 'Member Provider (member-provider)',
    })
  })

  it('falls back to agentType when session and providerId metadata are unavailable', () => {
    expect(resolveSessionProviderDisplay(null, [], { agentType: AgentType.CLAUDE_CODE })).toEqual({
      label: AgentType.CLAUDE_CODE,
      title: AgentType.CLAUDE_CODE,
    })
  })

  it('renders readonly provider and token usage metadata', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root!.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(SessionReadonlyMeta, {
            session: session({
              providerId: 'provider-focused',
              tokenUsage: { totalTokens: 12_500 },
            }),
            providers: [provider('provider-focused', 'Focused Provider')],
            usage: { totalTokens: 12_500 },
          }),
        ),
      )
    })

    expect(container.textContent).toContain('Focused Provider')
    expect(container.textContent).toContain('12.5K')
    expect(container.querySelector('[title="Provider: Focused Provider (provider-focused)"]')).not.toBeNull()
  })

  it('renders fallback provider metadata and a downward token tooltip for header placement', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root!.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(SessionReadonlyMeta, {
            session: null,
            providers: [provider('member-provider', 'Member Provider')],
            usage: { totalTokens: 9_500 },
            providerIdFallback: 'member-provider',
            agentTypeFallback: AgentType.CODEX,
            tokenTooltipSide: 'bottom',
          }),
        ),
      )
    })

    expect(container.textContent).toContain('Member Provider')
    expect(container.textContent).toContain('9.5K')
    expect(container.innerHTML).toContain('top-full')
  })
})
