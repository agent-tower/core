// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentType, RuntimeType, PROVIDER_CAPABILITIES, type ProviderDraftTestResult } from '@agent-tower/shared'
import {
  ProviderFormModal,
  type ProviderFormData,
} from '../ProviderSettingsPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hookMocks = vi.hoisted(() => ({
  mutate: vi.fn(),
}))

vi.mock('@/hooks/use-providers', () => ({
  useProviderCapabilities: () => ({ data: Object.fromEntries(Object.entries(PROVIDER_CAPABILITIES).map(([agent, capability]) => [agent, {
    ...capability, executionPermissionOptions: {
      CLI: [{ mode: 'ASK', supported: false, authorized: true, selectable: false, reasons: [{ code: 'RUNTIME_MODE_UNSUPPORTED', message: 'Use ACP for approval' }] }, { mode: 'AUTO_SANDBOX', supported: false, authorized: true, selectable: false, reasons: [{ code: 'CAPABILITY_UNVERIFIED', message: 'Sandbox not verified' }] }, { mode: 'FULL_ACCESS', supported: true, authorized: true, selectable: true, reasons: [] }],
      ACP: ['ASK', 'AUTO_SANDBOX', 'FULL_ACCESS'].map(mode => ({ mode, supported: true, authorized: true, selectable: true, reasons: [] })),
    },
  }])) }),
  useTestProviderDraft: () => ({ mutate: hookMocks.mutate, isPending: false }),
}))

vi.mock('@/lib/i18n', () => ({
  translate: (source: string) => source,
  useI18n: () => ({ locale: 'zh-CN', t: (source: string) => source }),
}))

let root: Root | undefined
let container: HTMLDivElement | undefined

const successfulResult: ProviderDraftTestResult = {
  ok: true,
  stage: 'connection',
  summary: 'Connection verified',
  target: { kind: 'api', source: 'codex-openai', endpoint: 'https://old.example/v1/models' },
  testedAt: '2026-07-15T10:20:30.000Z',
}

function initialCodexData(overrides: Partial<ProviderFormData> = {}): ProviderFormData {
  return {
    name: 'Codex Test',
    agentType: AgentType.CODEX,
    runtimeType: RuntimeType.CLI,
    executionPermission: 'FULL_ACCESS',
    config: {},
    settings: '',
    env: [],
    simplified: { apiKey: { configured: false, envKey: 'OPENAI_API_KEY' } },
    diagnostics: [],
    isDefault: false,
    ...overrides,
  }
}

function renderModal(
  initialData?: ProviderFormData,
  onSave: Parameters<typeof ProviderFormModal>[0]['onSave'] = () => {},
) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(
    <ProviderFormModal
      isOpen
      onClose={() => {}}
      initialData={initialData}
      onSave={onSave}
    />,
  ))
}

function findButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')]
    .find(item => item.textContent?.trim() === label)
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}

function selectExecutionPermission(label: string) {
  const trigger = document.querySelector('fieldset button[aria-expanded]') as HTMLButtonElement
  act(() => trigger.click())
  const option = [...document.querySelectorAll<HTMLButtonElement>('fieldset button[aria-pressed]')]
    .find(button => button.textContent?.includes(label))
  if (!option) throw new Error(`Permission option not found: ${label}`)
  act(() => option.click())
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

function beginTest() {
  act(() => findButton('测试配置').click())
  expect(hookMocks.mutate).toHaveBeenCalledTimes(1)
  return hookMocks.mutate.mock.calls[0]![1] as {
    onSuccess: (result: ProviderDraftTestResult) => void
  }
}

function findWebsocketSwitch(): HTMLButtonElement | null {
  return document.querySelector('[role="switch"][aria-label="禁用 WebSocket"]')
}

function findFastModeControl(): HTMLButtonElement | null {
  return document.querySelector('[data-fast-mode-control] button')
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  document.body.replaceChildren()
  root = undefined
  container = undefined
})

beforeEach(() => {
  hookMocks.mutate.mockReset()
  window.confirm = vi.fn(() => true)
})

describe('ProviderFormModal draft test invalidation', () => {
  it('selects Codex ACP as an Agent option without exposing a runtime tab', () => {
    const onSave = vi.fn()
    renderModal(undefined, onSave)

    act(() => findButton('Claude Code').click())
    act(() => findButton('Codex (ACP)').click())
    changeTextInput(document.querySelector('#provider-name') as HTMLInputElement, 'Codex ACP Test')

    expect(document.querySelector('#provider-api-url')).not.toBeNull()
    expect(document.querySelector('#provider-model')).not.toBeNull()
    expect(findFastModeControl()).not.toBeNull()
    expect(findButton('高级配置')).not.toBeNull()
    expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === 'CLI')).toBe(false)
    expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === 'ACP')).toBe(false)

    selectExecutionPermission('Ask for approval')
    selectExecutionPermission('Auto approve (full access)')

    expect(window.confirm).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Use native broad approval and disable the configurable sandbox. Upstream rules still apply.')

    act(() => findButton('保存 Provider').click())

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.ACP,
      executionPermission: 'FULL_ACCESS',
      config: {},
    }))
  })

  it('offers every user-visible ACP-only and dual-runtime Agent choice', () => {
    const onSave = vi.fn()
    renderModal(undefined, onSave)

    act(() => findButton('Claude Code').click())
    expect(findButton('Claude Code (ACP)')).not.toBeNull()
    expect(findButton('Qwen Code (ACP)')).not.toBeNull()
    expect(findButton('Gemini CLI (ACP)')).not.toBeNull()
    expect(findButton('Cursor Agent (ACP)')).not.toBeNull()
    expect(findButton('Kiro CLI (ACP)')).not.toBeNull()
    expect(findButton('OpenCode (ACP)')).not.toBeNull()
    expect(findButton('Pi Coding Agent (ACP)')).not.toBeNull()
    expect(findButton('Grok Build (ACP)')).not.toBeNull()
    expect([...document.querySelectorAll('button')].some(
      button => button.textContent?.trim() === 'Minion Code (ACP)'
    )).toBe(false)
    expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Qwen Code')).toBe(false)

    act(() => findButton('Qwen Code (ACP)').click())
    changeTextInput(document.querySelector('#provider-name') as HTMLInputElement, 'Qwen ACP Test')
    act(() => findButton('保存 Provider').click())

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      agentType: AgentType.QWEN_CODE,
      runtimeType: RuntimeType.ACP,
      executionPermission: 'ASK',
      config: {},
    }))
  })

  it('renders a legacy ACP yolo flag as unrestricted access', () => {
    renderModal({
      name: 'Legacy Qwen ACP',
      agentType: AgentType.QWEN_CODE,
      runtimeType: RuntimeType.ACP,
      config: { yolo: true },
      settings: '',
      env: [],
      simplified: {},
      diagnostics: [],
      isDefault: false,
    })

    expect(findButton('Auto approve (full access)')).not.toBeNull()
    expect(document.body.textContent).toContain('Use native broad approval and disable the configurable sandbox. Upstream rules still apply.')
  })

  it('does not restore an old response after a structured field changes', () => {
    renderModal(initialCodexData())
    const request = beginTest()
    changeTextInput(document.querySelector('#provider-api-url') as HTMLInputElement, 'https://new.example/v1')

    act(() => request.onSuccess(successfulResult))
    expect(document.querySelector('[data-provider-test-result]')).toBeNull()
  })

  it('does not restore an old response after the Agent type changes', () => {
    renderModal()
    selectExecutionPermission('Auto approve (full access)')
    const request = beginTest()
    act(() => findButton('Claude Code').click())
    act(() => findButton('Codex').click())

    act(() => request.onSuccess(successfulResult))
    expect(document.querySelector('[data-provider-test-result]')).toBeNull()
  })

  it('does not restore an old response after raw JSON becomes invalid', () => {
    renderModal(initialCodexData())
    act(() => findButton('高级配置').click())
    const request = beginTest()
    changeTextInput(document.querySelector('textarea') as HTMLTextAreaElement, '{')

    act(() => request.onSuccess(successfulResult))
    expect(document.querySelector('[data-provider-test-result]')).toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).not.toBe('')
  })

  it('invalidates an in-flight test when the Codex WebSocket control changes', () => {
    renderModal(initialCodexData())
    const request = beginTest()
    const transportSwitch = findWebsocketSwitch()
    expect(transportSwitch?.getAttribute('aria-checked')).toBe('false')

    act(() => transportSwitch?.click())
    act(() => request.onSuccess(successfulResult))

    expect(transportSwitch?.getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-provider-test-result]')).toBeNull()
  })

  it('invalidates an in-flight test when Codex Fast mode changes', () => {
    renderModal(initialCodexData())
    const request = beginTest()
    const fastModeControl = findFastModeControl()
    expect(fastModeControl?.textContent).toContain('跟随 Codex')

    act(() => fastModeControl?.click())
    act(() => findButton('Fast').click())
    act(() => request.onSuccess(successfulResult))

    expect(fastModeControl?.textContent).toContain('Fast')
    expect(document.querySelector('[data-provider-test-result]')).toBeNull()
  })

  it('writes simplified Codex URL, model, and reasoning changes into Advanced', () => {
    renderModal(initialCodexData({
      config: {
        model: 'gpt-old',
        unknownConfig: { keep: true },
      },
      settings: [
        '# keep leading',
        'openai_base_url = "https://old.example/v1" # keep URL note',
        'model_reasoning_effort = "medium" # keep effort note',
        'unknown_setting = "keep"',
      ].join('\n'),
      simplified: {
        apiBaseUrl: 'https://old.example/v1',
        apiKey: { configured: false, envKey: 'OPENAI_API_KEY' },
        model: 'gpt-old',
        reasoningEffort: 'medium',
      },
    }))

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

    act(() => findButton('高级配置').click())
    const [configInput, settingsInput] = document.querySelectorAll('textarea')
    expect(JSON.parse((configInput as HTMLTextAreaElement).value)).toEqual({
      model: 'gpt-new',
      unknownConfig: { keep: true },
    })
    expect((settingsInput as HTMLTextAreaElement).value)
      .toContain('openai_base_url = "https://new.example/v1" # keep URL note')
    expect((settingsInput as HTMLTextAreaElement).value)
      .toContain('model_reasoning_effort = "xhigh" # keep effort note')
    expect((settingsInput as HTMLTextAreaElement).value).toContain('unknown_setting = "keep"')
  })

  it('reflects Advanced Codex URL, model, and reasoning changes in simplified fields', () => {
    const onSave = vi.fn()
    renderModal(initialCodexData({
      config: { model: 'gpt-old', unknownConfig: { keep: true } },
      settings: 'openai_base_url = "https://old.example/v1"\nmodel_reasoning_effort = "medium"\n',
      simplified: {
        apiBaseUrl: 'https://old.example/v1',
        apiKey: { configured: false, envKey: 'OPENAI_API_KEY' },
        model: 'gpt-old',
        reasoningEffort: 'medium',
      },
    }), onSave)

    act(() => findButton('高级配置').click())
    const [configInput, settingsInput] = document.querySelectorAll('textarea')
    changeTextInput(configInput as HTMLTextAreaElement, JSON.stringify({
      model: 'gpt-advanced',
      unknownConfig: { keep: true },
    }, null, 2))
    changeTextInput(settingsInput as HTMLTextAreaElement, [
      'openai_base_url = "https://advanced.example/v1"',
      'model_reasoning_effort = "high"',
      'unknown_setting = "keep"',
    ].join('\n'))

    expect((document.querySelector('#provider-api-url') as HTMLInputElement).value)
      .toBe('https://advanced.example/v1')
    expect((document.querySelector('#provider-model') as HTMLInputElement).value).toBe('gpt-advanced')
    expect(document.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe('高, high')

    act(() => findButton('保存 Provider').click())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      config: { model: 'gpt-advanced', unknownConfig: { keep: true } },
      settings: expect.stringContaining('unknown_setting = "keep"'),
    })
  })

  it('keeps the Codex WebSocket control and Advanced JSON in one config state', () => {
    const onSave = vi.fn()
    renderModal(initialCodexData(), onSave)
    const transportSwitch = findWebsocketSwitch()
    expect(transportSwitch).not.toBeNull()

    act(() => transportSwitch?.click())
    act(() => findButton('高级配置').click())
    const configInput = document.querySelector('textarea') as HTMLTextAreaElement
    expect(JSON.parse(configInput.value)).toMatchObject({ disableResponsesWebsocket: true })

    changeTextInput(configInput, JSON.stringify({
      disableResponsesWebsocket: false,
      unknown: { keep: true },
    }, null, 2))
    expect(transportSwitch?.getAttribute('aria-checked')).toBe('false')

    act(() => findButton('保存 Provider').click())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0].config).toEqual({
      disableResponsesWebsocket: false,
      unknown: { keep: true },
    })
  })

  it('keeps the Codex Fast mode control and Advanced JSON in one config state', () => {
    const onSave = vi.fn()
    renderModal(initialCodexData(), onSave)
    const fastModeControl = findFastModeControl()
    expect(fastModeControl).not.toBeNull()

    act(() => fastModeControl?.click())
    act(() => findButton('Fast').click())
    act(() => findButton('高级配置').click())
    const configInput = document.querySelector('textarea') as HTMLTextAreaElement
    expect(JSON.parse(configInput.value)).toMatchObject({ fastMode: true })

    changeTextInput(configInput, JSON.stringify({ fastMode: false, unknown: 'keep' }, null, 2))
    expect(fastModeControl?.textContent).toContain('标准速度')

    act(() => findButton('保存 Provider').click())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0].config).toEqual({ fastMode: false, unknown: 'keep' })
  })

  it('shows unified permission choices and removes legacy flags on explicit reselection', () => {
    const onSave = vi.fn()
    renderModal(initialCodexData({ config: { dangerouslyBypassApprovalsAndSandbox: true } }), onSave)
    expect(document.querySelector('[role="switch"][aria-label="跳过所有确认和沙盒"]')).toBeNull()
    expect(document.body.textContent).toContain('Execution permission')
    selectExecutionPermission('Auto approve (full access)')
    act(() => findButton('保存 Provider').click())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ executionPermission: 'FULL_ACCESS', config: {} }))
  })

  it('keeps migrated Codex ACP ASK blocked until the user explicitly reselects ASK', () => {
    const onSave = vi.fn()
    renderModal(initialCodexData({ runtimeType: RuntimeType.ACP, executionPermission: 'ASK', executionPermissionReviewRequired: true, config: {} }), onSave)
    expect(document.body.textContent).toContain('Legacy Codex permissions did not establish an explicit reviewer policy.')
    expect(findButton('保存 Provider').disabled).toBe(true)
    expect(findButton('测试配置').disabled).toBe(true)
    selectExecutionPermission('Ask for approval')
    expect(document.body.textContent).not.toContain('Legacy Codex permissions did not establish an explicit reviewer policy.')
    expect(findButton('保存 Provider').disabled).toBe(false)
    act(() => findButton('保存 Provider').click())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ executionPermission: 'ASK', config: {} }))
  })

  it('blocks Advanced save and test when Codex permission is not boolean', () => {
    renderModal(initialCodexData())
    act(() => findButton('高级配置').click())
    const configInput = document.querySelector('textarea') as HTMLTextAreaElement
    changeTextInput(configInput, JSON.stringify({ dangerouslyBypassApprovalsAndSandbox: 'true' }))

    expect(document.body.textContent).toContain('dangerouslyBypassApprovalsAndSandbox must be true or false')
    expect(findButton('测试配置').disabled).toBe(true)
    expect(findButton('保存 Provider').disabled).toBe(true)
  })

  it('opens Advanced immediately when initial data has an invalid Codex permission', () => {
    renderModal(initialCodexData({
      config: { dangerouslyBypassApprovalsAndSandbox: 'true' },
    }))

    expect(findButton('高级配置').getAttribute('aria-expanded')).toBe('true')
    expect(document.body.textContent).toContain('dangerouslyBypassApprovalsAndSandbox must be true or false')
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value)
      .toContain('dangerouslyBypassApprovalsAndSandbox')
    expect(findButton('测试配置').disabled).toBe(true)
    expect(findButton('保存 Provider').disabled).toBe(true)
  })

  it('reopens the saved control and blocks test/save for an invalid advanced type', () => {
    renderModal(initialCodexData({
      config: { disableResponsesWebsocket: true },
    }))
    const transportSwitch = findWebsocketSwitch()
    expect(transportSwitch?.getAttribute('aria-checked')).toBe('true')

    act(() => findButton('高级配置').click())
    const configInput = document.querySelector('textarea') as HTMLTextAreaElement
    changeTextInput(configInput, JSON.stringify({ disableResponsesWebsocket: 'true' }))

    expect(transportSwitch?.disabled).toBe(true)
    expect(document.body.textContent).toContain('禁用 WebSocket 字段必须为 true 或 false')
    expect(findButton('测试配置').disabled).toBe(true)
    expect(findButton('保存 Provider').disabled).toBe(true)
  })

  it('blocks test and save for an invalid Fast mode type', () => {
    renderModal(initialCodexData({ config: { fastMode: 'true' } }))
    const fastModeControl = findFastModeControl()

    expect(fastModeControl?.disabled).toBe(true)
    expect(document.body.textContent).toContain('Fast 模式字段必须为 true 或 false')
    expect(findButton('测试配置').disabled).toBe(true)
    expect(findButton('保存 Provider').disabled).toBe(true)
  })

  it('explains the native Codex transport accurately', () => {
    renderModal(initialCodexData({ settings: 'model_provider = "ollama"\n' }))
    expect(findWebsocketSwitch()).not.toBeNull()
    expect(document.body.textContent).toContain('当前原生 Provider 已使用非 WebSocket 传输')
  })

  it('does not show the WebSocket control for other agents', () => {
    renderModal({
      ...initialCodexData(),
      agentType: AgentType.CLAUDE_CODE,
    })
    expect(findWebsocketSwitch()).toBeNull()
    expect(findFastModeControl()).toBeNull()
  })

  it('keeps native Codex connection fields under advanced settings', () => {
    renderModal(initialCodexData({ settings: 'model_provider = "ollama"\n' }))
    expect(document.querySelector('#provider-api-url')).toBeNull()
    expect(document.querySelector('#provider-api-key')).toBeNull()
    act(() => findButton('高级配置').click())
    expect(document.body.textContent).toContain('原生配置')
  })

  it('keeps a dynamically selected non-typical credential row as a password input', () => {
    const secret = 'dynamic-page-value-sentinel'
    renderModal(initialCodexData({
      env: [{
        key: 'PROXY_ACCESS',
        value: '',
        write: { action: 'keep' },
        configured: true,
        sensitive: false,
      }],
    }))
    act(() => findButton('高级配置').click())
    const settingsInput = [...document.querySelectorAll('textarea')].at(-1) as HTMLTextAreaElement
    changeTextInput(settingsInput, [
      'model_provider = "proxy"',
      '[model_providers.proxy]',
      'base_url = "https://proxy.example/v1"',
      'env_key = "PROXY_ACCESS"',
    ].join('\n'))

    act(() => findButton('替换').click())
    const simpleKeyInput = document.querySelector('#provider-api-key') as HTMLInputElement
    changeTextInput(simpleKeyInput, secret)
    const envKeyInput = [...document.querySelectorAll('input')]
      .find(item => item.value === 'PROXY_ACCESS') as HTMLInputElement
    const envValueInput = envKeyInput.parentElement?.querySelectorAll('input')[1]

    expect(envValueInput?.type).toBe('password')
    expect(envValueInput?.value === secret).toBe(true)
  })

  it('masks a newly added env row from the first active custom env_key match and keeps it sticky', () => {
    renderModal(initialCodexData())
    act(() => findButton('高级配置').click())
    const settingsInput = [...document.querySelectorAll('textarea')].at(-1) as HTMLTextAreaElement
    changeTextInput(settingsInput, [
      'model_provider = "proxy"',
      '[model_providers.proxy]',
      'base_url = "https://proxy.example/v1"',
      'env_key = "PROXY_ACCESS"',
    ].join('\n'))

    act(() => findButton('添加变量').click())
    const envKeyInput = document.querySelector(
      'input[placeholder="变量名，如 AZURE_OPENAI_API_KEY"]',
    ) as HTMLInputElement
    const envValueInput = envKeyInput.parentElement?.querySelectorAll('input')[1] as HTMLInputElement
    expect(envValueInput.type).toBe('text')

    changeTextInput(envKeyInput, '  PROXY_ACCESS  ')
    expect(envValueInput.type).toBe('password')

    changeTextInput(envValueInput, 'credential-input-value')
    expect(envValueInput.type).toBe('password')

    changeTextInput(envKeyInput, 'RENAMED_SETTING')
    expect(envValueInput.type).toBe('password')
  })

  it('reuses an active credential env row whose key has boundary spaces', () => {
    renderModal(initialCodexData({
      env: [{
        key: '  PROXY_ACCESS  ',
        value: '',
        write: { action: 'keep' },
        configured: true,
        sensitive: true,
      }],
      simplified: { apiKey: { configured: false, envKey: 'PROXY_ACCESS' } },
      settings: [
        'model_provider = "proxy"',
        '[model_providers.proxy]',
        'base_url = "https://proxy.example/v1"',
        'env_key = "PROXY_ACCESS"',
      ].join('\n'),
    }))

    expect(document.querySelector('#provider-api-key')).toBeNull()
    act(() => findButton('替换').click())
    const simpleKeyInput = document.querySelector('#provider-api-key') as HTMLInputElement
    changeTextInput(simpleKeyInput, 'updated-credential-value')
    act(() => findButton('高级配置').click())

    const envKeyInputs = document.querySelectorAll('input[placeholder="变量名，如 AZURE_OPENAI_API_KEY"]')
    expect(envKeyInputs).toHaveLength(1)
    expect((envKeyInputs[0] as HTMLInputElement).value).toBe('  PROXY_ACCESS  ')
    const envValueInput = envKeyInputs[0]?.parentElement?.querySelectorAll('input')[1] as HTMLInputElement
    expect(envValueInput.value).toBe('updated-credential-value')
    expect(envValueInput.type).toBe('password')
  })

  it.each([
    ['replace', ['PROXY_ACCESS', '  PROXY_ACCESS  ']],
    ['replace', ['  PROXY_ACCESS  ', 'PROXY_ACCESS']],
    ['clear', ['PROXY_ACCESS', '  PROXY_ACCESS  ']],
    ['clear', ['  PROXY_ACCESS  ', 'PROXY_ACCESS']],
  ] as const)('preserves a basic API key %s with duplicate alias rows in either order', (action, keys) => {
    const onSave = vi.fn()
    renderModal(initialCodexData({
      env: keys.map(key => ({
        key,
        value: '',
        write: { action: 'keep' },
        configured: true,
        sensitive: true,
      })),
      simplified: { apiKey: { configured: true, envKey: 'PROXY_ACCESS' } },
      settings: [
        'model_provider = "proxy"',
        '[model_providers.proxy]',
        'base_url = "https://proxy.example/v1"',
        'env_key = "PROXY_ACCESS"',
      ].join('\n'),
    }), onSave)

    if (action === 'replace') {
      act(() => findButton('替换').click())
      changeTextInput(document.querySelector('#provider-api-key') as HTMLInputElement, 'updated-credential-value')
    } else {
      act(() => findButton('清除').click())
    }
    act(() => findButton('保存 Provider').click())

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0].env).toEqual({
      PROXY_ACCESS: action === 'replace'
        ? { action: 'replace', value: 'updated-credential-value' }
        : { action: 'clear' },
    })
  })
})
