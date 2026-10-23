// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentType,
  PROVIDER_CAPABILITIES,
  type ProviderDraftInput,
  type ProviderDraftTestResult,
} from '@agent-tower/shared'
import type {
  ProviderWithAvailability,
  UpdateProviderInput,
} from '@/hooks/use-providers'
import {
  syncSimplifiedFromConfig,
  syncSimplifiedFromSettings,
} from '@/components/provider/provider-draft'
import { ProviderSettingsPage } from '../ProviderSettingsPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface MutationCallbacks<T = unknown> {
  onSuccess?: (value: T) => void
  onError?: (error: Error) => void
}

const hookMocks = vi.hoisted(() => ({
  providers: [] as unknown[],
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  testDraft: vi.fn(),
  exportBackup: vi.fn(),
  previewImport: vi.fn(),
  importBackup: vi.fn(),
}))

vi.mock('@/hooks/use-providers', () => ({
  useProviders: () => ({ data: hookMocks.providers, isLoading: false }),
  useCreateProvider: () => ({ mutate: hookMocks.create, isPending: false }),
  useUpdateProvider: () => ({ mutate: hookMocks.update, isPending: false }),
  useDeleteProvider: () => ({ mutate: hookMocks.remove, isPending: false }),
  useTestProviderDraft: () => ({ mutate: hookMocks.testDraft, isPending: false }),
  useProviderCapabilities: () => ({ data: Object.fromEntries(Object.entries(PROVIDER_CAPABILITIES).map(([agent, capability]) => [agent, {
    ...capability, executionPermissionOptions: {
      CLI: [{ mode: 'ASK', supported: false, authorized: true, selectable: false, reasons: [{ code: 'RUNTIME_MODE_UNSUPPORTED', message: 'Use ACP for approval' }] }, { mode: 'AUTO_SANDBOX', supported: false, authorized: true, selectable: false, reasons: [{ code: 'CAPABILITY_UNVERIFIED', message: 'Sandbox not verified' }] }, { mode: 'FULL_ACCESS', supported: true, authorized: true, selectable: true, reasons: [] }],
      ACP: ['ASK', 'AUTO_SANDBOX', 'FULL_ACCESS'].map(mode => ({ mode, supported: true, authorized: true, selectable: true, reasons: [] })),
    },
  }])) }),
  useExportProviderBackup: () => ({ mutate: hookMocks.exportBackup, isPending: false }),
  usePreviewProviderImport: () => ({ mutate: hookMocks.previewImport, isPending: false }),
  useImportProviderBackup: () => ({ mutate: hookMocks.importBackup, isPending: false }),
}))

vi.mock('@/lib/i18n', () => ({
  translate: (source: string) => source,
  useI18n: () => ({ locale: 'zh-CN', t: (source: string) => source }),
}))

let root: Root | undefined
let container: HTMLDivElement | undefined

function providerFixture(
  overrides: Partial<ProviderWithAvailability['provider']> = {},
): ProviderWithAvailability {
  return {
    provider: {
      id: 'codex-fixture',
      name: 'Codex Fixture',
      agentType: AgentType.CODEX,
      executionPermission: 'FULL_ACCESS',
      env: {},
      redactedEnv: {
        OPENAI_API_KEY: { configured: true, sensitive: true },
      },
      config: {
        model: 'gpt-old',
        unknownConfig: { keep: true },
      },
      settings: [
        '# keep leading comment',
        'openai_base_url = "https://old.example/v1" # keep URL note',
        'model_reasoning_effort = "medium" # keep effort note',
        'unknown_setting = "keep"',
      ].join('\n'),
      simplified: {
        apiBaseUrl: 'https://old.example/v1',
        apiKey: { configured: true, envKey: 'OPENAI_API_KEY' },
        model: 'gpt-old',
        reasoningEffort: 'medium',
      },
      diagnostics: [],
      isDefault: true,
      builtIn: false,
      deletable: true,
      ...overrides,
    },
    availability: { type: 'LOGIN_DETECTED' },
  }
}

function renderPage() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<ProviderSettingsPage />))
}

function findButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')]
    .find(item => item.textContent?.trim() === label)
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}

function changeTextInput(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function openEditor() {
  const selected = document.querySelector('button[aria-current="true"]') as HTMLButtonElement | null
  if (!selected) throw new Error('Selected Provider button not found')
  act(() => selected.click())
  act(() => findButton('编辑').click())
  expect(document.querySelector('#provider-name')).not.toBeNull()
}

function advancedInputs() {
  act(() => findButton('高级配置').click())
  const inputs = [...document.querySelectorAll('textarea')] as HTMLTextAreaElement[]
  expect(inputs).toHaveLength(2)
  return { configInput: inputs[0]!, settingsInput: inputs[1]! }
}

function persistedProvider() {
  return (hookMocks.providers as ProviderWithAvailability[])[0]!.provider
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  document.body.replaceChildren()
  root = undefined
  container = undefined
})

beforeEach(() => {
  hookMocks.providers = [providerFixture()]
  for (const mock of Object.values(hookMocks)) {
    if (typeof mock === 'function' && 'mockReset' in mock) mock.mockReset()
  }

  hookMocks.update.mockImplementation((
    payload: { id: string; data: UpdateProviderInput },
    callbacks?: MutationCallbacks,
  ) => {
    const providers = hookMocks.providers as ProviderWithAvailability[]
    const index = providers.findIndex(item => item.provider.id === payload.id)
    const previous = providers[index]
    if (!previous) throw new Error(`Provider not found: ${payload.id}`)
    const config = payload.data.config ?? previous.provider.config
    const settings = payload.data.settings ?? previous.provider.settings ?? ''
    const simplifiedDraft = {
      ...previous.provider.simplified,
      ...payload.data.simplified,
    }
    const simplified = syncSimplifiedFromSettings(
      syncSimplifiedFromConfig(
        simplifiedDraft,
        config,
        PROVIDER_CAPABILITIES[AgentType.CODEX],
      ),
      settings,
      AgentType.CODEX,
    )
    providers[index] = {
      ...previous,
      provider: {
        ...previous.provider,
        ...payload.data,
        env: {},
        redactedEnv: previous.provider.redactedEnv,
        simplified,
      },
    }
    callbacks?.onSuccess?.(providers[index]!.provider)
  })

  const result: ProviderDraftTestResult = {
    ok: true,
    stage: 'connection',
    summary: 'Connection verified',
    target: { kind: 'api', source: 'codex-openai', endpoint: 'https://new.example/v1/models' },
  }
  hookMocks.testDraft.mockImplementation((
    _draft: ProviderDraftInput,
    callbacks?: MutationCallbacks<ProviderDraftTestResult>,
  ) => callbacks?.onSuccess?.(result))
  window.confirm = vi.fn(() => true)
})

describe('ProviderSettingsPage deterministic behavior fixture', () => {
  it('disables and re-enables a configuration while keeping it in the management list', () => {
    renderPage()
    const toggle = () => document.querySelector<HTMLButtonElement>('#provider-enabled')!
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    const original = persistedProvider()

    act(() => toggle().click())
    expect(hookMocks.update).toHaveBeenLastCalledWith(
      { id: original.id, data: { enabled: false } },
      expect.any(Object),
    )
    act(() => root!.render(<ProviderSettingsPage />))
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    const selected = document.querySelector<HTMLButtonElement>('button[aria-current="true"]')!
    expect(selected.textContent).toContain(original.name)
    expect(selected.textContent).toContain('已禁用')
    expect(selected.querySelector('[title]')?.getAttribute('title')).toBe('已禁用')
    expect(persistedProvider()).toMatchObject({
      enabled: false,
      config: original.config,
      settings: original.settings,
      redactedEnv: original.redactedEnv,
    })

    act(() => toggle().click())
    expect(hookMocks.update).toHaveBeenLastCalledWith(
      { id: original.id, data: { enabled: true } },
      expect.any(Object),
    )
    act(() => root!.render(<ProviderSettingsPage />))
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(selected.textContent).not.toContain('已禁用')
  })

  it('keeps a disabled configuration disabled when its other settings are edited', () => {
    hookMocks.providers = [providerFixture({ enabled: false })]
    renderPage()
    openEditor()
    changeTextInput(document.querySelector('#provider-name') as HTMLInputElement, 'Renamed disabled provider')
    act(() => findButton('保存 Provider').click())
    expect(persistedProvider()).toMatchObject({ name: 'Renamed disabled provider', enabled: false })
    expect(hookMocks.update.mock.calls[0]![0].data).not.toHaveProperty('enabled')
    expect(document.querySelector('#provider-enabled')?.getAttribute('aria-checked')).toBe('false')
  })

  it('keeps the enabled state when its update fails', () => {
    hookMocks.update.mockImplementation((_payload: unknown, callbacks?: MutationCallbacks) => {
      callbacks?.onError?.(new Error('Could not save'))
    })
    renderPage()
    act(() => document.querySelector<HTMLButtonElement>('#provider-enabled')!.click())
    expect(document.querySelector('#provider-enabled')?.getAttribute('aria-checked')).toBe('true')
    expect(persistedProvider().enabled).not.toBe(false)
  })

  it('keeps list and detail availability aligned with refreshed permission capability', () => {
    const reason = 'Remove sandbox_workspace_write from Codex advanced settings before using automatic sandbox approval.'
    const base = providerFixture({ executionPermission: 'AUTO_SANDBOX' })
    hookMocks.providers = [base]
    renderPage()
    const selected = () => document.querySelector<HTMLButtonElement>('button[aria-current="true"]')!
    expect(selected().querySelector('[title]')?.getAttribute('title')).toBe('可用')
    expect(document.body.textContent).toContain('可用')

    hookMocks.providers = [{
      ...base,
      provider: {
        ...base.provider,
        executionPermissionOptions: [{ mode: 'AUTO_SANDBOX', supported: false, authorized: true, selectable: false, reasons: [{ code: 'CONFLICT', message: reason }] }],
      },
    }]
    act(() => root!.render(<ProviderSettingsPage />))
    expect(selected().querySelector('[title]')?.getAttribute('title')).toContain(reason)
    expect(selected().textContent).toContain(reason)
    expect(document.body.textContent).toContain('不可用')
    expect(document.body.textContent).toContain(reason)

    hookMocks.providers = [base]
    act(() => root!.render(<ProviderSettingsPage />))
    expect(selected().querySelector('[title]')?.getAttribute('title')).toBe('可用')
  })

  it('syncs simplified Codex fields into Advanced, tests, saves, and reopens persisted values', () => {
    renderPage()
    openEditor()

    changeTextInput(
      document.querySelector('#provider-api-url') as HTMLInputElement,
      'https://new.example/v1',
    )
    changeTextInput(
      document.querySelector('#provider-model') as HTMLInputElement,
      'gpt-new',
    )
    const slider = document.querySelector('[role="slider"]') as HTMLElement
    act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))

    const { configInput, settingsInput } = advancedInputs()
    expect(JSON.parse(configInput.value)).toMatchObject({
      model: 'gpt-new',
      unknownConfig: { keep: true },
    })
    expect(settingsInput.value).toContain('openai_base_url = "https://new.example/v1" # keep URL note')
    expect(settingsInput.value).toContain('model_reasoning_effort = "xhigh" # keep effort note')
    expect(settingsInput.value).toContain('unknown_setting = "keep"')

    expect(findButton('测试配置').disabled).toBe(false)
    expect(findButton('保存 Provider').disabled).toBe(false)
    act(() => findButton('测试配置').click())
    expect(hookMocks.testDraft).toHaveBeenCalledTimes(1)
    expect(hookMocks.testDraft.mock.calls[0]![0]).toMatchObject({
      providerId: 'codex-fixture',
      executionPermission: 'FULL_ACCESS',
      config: { model: 'gpt-new' },
      simplified: {
        apiBaseUrl: 'https://new.example/v1',
        model: 'gpt-new',
        reasoningEffort: 'xhigh',
      },
    })

    act(() => findButton('保存 Provider').click())
    expect(hookMocks.update).toHaveBeenCalledTimes(1)
    expect(document.querySelector('#provider-name')).toBeNull()
    expect(persistedProvider().settings).toContain('openai_base_url = "https://new.example/v1"')

    openEditor()
    expect((document.querySelector('#provider-api-url') as HTMLInputElement).value)
      .toBe('https://new.example/v1')
    expect((document.querySelector('#provider-model') as HTMLInputElement).value).toBe('gpt-new')
    expect(document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext'))
      .toBe('超高, xhigh')
  })

  it('syncs valid Advanced JSON and TOML back into simplified fields', () => {
    renderPage()
    openEditor()
    const { configInput, settingsInput } = advancedInputs()

    changeTextInput(configInput, JSON.stringify({
      model: 'gpt-advanced',
      unknownConfig: { keep: true },
    }, null, 2))
    changeTextInput(settingsInput, [
      'openai_base_url = "https://advanced.example/v1"',
      'model_reasoning_effort = "high"',
      'unknown_setting = "keep"',
    ].join('\n'))

    expect((document.querySelector('#provider-api-url') as HTMLInputElement).value)
      .toBe('https://advanced.example/v1')
    expect((document.querySelector('#provider-model') as HTMLInputElement).value)
      .toBe('gpt-advanced')
    expect(document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext'))
      .toBe('高, high')
    expect(findButton('测试配置').disabled).toBe(false)
    expect(findButton('保存 Provider').disabled).toBe(false)

    act(() => findButton('保存 Provider').click())
    openEditor()
    expect((document.querySelector('#provider-api-url') as HTMLInputElement).value)
      .toBe('https://advanced.example/v1')
    expect((document.querySelector('#provider-model') as HTMLInputElement).value)
      .toBe('gpt-advanced')
  })

  it('blocks test and save when Advanced permission is not a boolean', () => {
    renderPage()
    openEditor()
    const { configInput } = advancedInputs()

    changeTextInput(configInput, JSON.stringify({
      model: 'gpt-old',
      dangerouslyBypassApprovalsAndSandbox: 'true',
    }, null, 2))

    expect(document.body.textContent).toContain('dangerouslyBypassApprovalsAndSandbox must be true or false')
    expect(findButton('测试配置').disabled).toBe(true)
    expect(findButton('保存 Provider').disabled).toBe(true)
    act(() => {
      findButton('测试配置').click()
      findButton('保存 Provider').click()
    })
    expect(hookMocks.testDraft).not.toHaveBeenCalled()
    expect(hookMocks.update).not.toHaveBeenCalled()
  })

  it('opens Advanced and reports invalid initial permission data immediately', () => {
    hookMocks.providers = [providerFixture({
      config: {
        model: 'gpt-old',
        dangerouslyBypassApprovalsAndSandbox: 'true',
      },
    })]
    renderPage()
    openEditor()

    expect(findButton('高级配置').getAttribute('aria-expanded')).toBe('true')
    expect(document.body.textContent).toContain('dangerouslyBypassApprovalsAndSandbox must be true or false')
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value)
      .toContain('dangerouslyBypassApprovalsAndSandbox')
    expect(findButton('测试配置').disabled).toBe(true)
    expect(findButton('保存 Provider').disabled).toBe(true)
  })
})
