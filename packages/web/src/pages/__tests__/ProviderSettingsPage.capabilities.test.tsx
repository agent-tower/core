// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AgentType, RuntimeType, PROVIDER_CAPABILITIES } from '@agent-tower/shared'
import { afterEach, expect, it, vi } from 'vitest'
import { ProviderFormModal } from '../ProviderSettingsPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ apiClient: { post } }))
vi.mock('@/lib/i18n', () => ({ translate: (s: string) => s, useI18n: () => ({ locale: 'zh-CN', t: (s: string) => s }) }))
let root: Root | undefined
let client: QueryClient | undefined
afterEach(() => { if (root) act(() => root!.unmount()); client?.clear(); document.body.replaceChildren(); post.mockReset() })

function changeConfig(config: Record<string, unknown>) {
  const textarea = [...document.querySelectorAll('textarea')].find(el => el.value.startsWith('{'))!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, JSON.stringify(config))
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function changeSettings(settings: string) {
  const textarea = [...document.querySelectorAll('textarea')].at(-1)!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, settings)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function permissionOption() {
  return [...document.querySelectorAll<HTMLButtonElement>('fieldset button[aria-pressed]')].find(el => el.textContent?.includes('Ask for approval'))!
}

it('refreshes and isolates current draft capabilities when removing/adding router and command overrides', async () => {
  post.mockImplementation(async (_url, body) => ({
    [AgentType.CLAUDE_CODE]: { ...PROVIDER_CAPABILITIES.CLAUDE_CODE, executionPermissionOptions: {
      CLI: ['ASK', 'AUTO_SANDBOX', 'FULL_ACCESS'].map(mode => ({
        mode, supported: mode === 'ASK' && !body.config.claudeCodeRouter && !body.config.cmd,
        authorized: mode === 'ASK', selectable: mode === 'ASK' && !body.config.claudeCodeRouter && !body.config.cmd,
        reasons: mode === 'ASK' && !body.config.claudeCodeRouter && !body.config.cmd ? [] : [{ code: 'CAPABILITY_UNVERIFIED', message: 'Draft launch override unavailable' }],
      })),
    } },
  }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const save = vi.fn()
  await act(async () => {
    root!.render(<QueryClientProvider client={client!}><ProviderFormModal isOpen providerId="imported-ask" onClose={() => {}} onSave={save} initialData={{
      name: 'Imported ASK', agentType: AgentType.CLAUDE_CODE, runtimeType: RuntimeType.CLI, executionPermission: 'ASK',
      config: { claudeCodeRouter: true }, settings: '', env: [], simplified: {}, diagnostics: [], isDefault: false,
    }} /></QueryClientProvider>)
  })
  act(() => (document.querySelector('fieldset button[aria-expanded]') as HTMLButtonElement).click())
  await act(async () => { await vi.waitFor(() => expect(permissionOption().disabled).toBe(true)) })
  const initialCalls = post.mock.calls.length
  changeConfig({})
  await act(async () => { await vi.waitFor(() => expect(permissionOption().disabled).toBe(false)) })
  expect(post.mock.calls.length).toBeGreaterThan(initialCalls)
  expect(post).toHaveBeenLastCalledWith('/providers/capabilities', expect.objectContaining({ providerId: 'imported-ask', config: {} }))
  const saveButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent?.trim() === '保存 Provider')!
  expect(saveButton.disabled).toBe(false)
  act(() => saveButton.click())
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ executionPermission: 'ASK', config: {} }))
  for (const config of [{ cmd: { baseCommandOverride: 'wrapper' } }, { cmd: { additionalParams: ['--extra'] } }, { claudeCodeRouter: true }]) {
    changeConfig(config)
    await act(async () => { await vi.waitFor(() => expect(permissionOption().disabled).toBe(true)) })
    expect(saveButton.disabled).toBe(true)
  }
  changeConfig({})
  await act(async () => { await vi.waitFor(() => expect(permissionOption().disabled).toBe(false)) })
  expect(saveButton.disabled).toBe(false)
  expect(client.getQueryCache().getAll().filter(query => query.queryKey[1] === 'capabilities')).toHaveLength(4)
})

it('refreshes Codex AUTO availability when advanced TOML changes', async () => {
  post.mockImplementation(async (_url, body) => ({
    [AgentType.CODEX]: { ...PROVIDER_CAPABILITIES.CODEX, executionPermissionOptions: {
      CLI: ['ASK', 'AUTO_SANDBOX', 'FULL_ACCESS'].map(mode => ({
        mode, supported: mode !== 'AUTO_SANDBOX' || !body.settings.includes('sandbox_workspace_write'),
        authorized: true, selectable: mode !== 'AUTO_SANDBOX' || !body.settings.includes('sandbox_workspace_write'),
        reasons: mode === 'AUTO_SANDBOX' && body.settings.includes('sandbox_workspace_write')
          ? [{ code: 'CONFLICT', message: 'Remove sandbox_workspace_write from Codex advanced settings before using automatic sandbox approval.' }] : [],
      })),
    } },
  }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const save = vi.fn()
  await act(async () => {
    root!.render(<QueryClientProvider client={client!}><ProviderFormModal isOpen providerId="codex-auto" onClose={() => {}} onSave={save} initialData={{
      name: 'Codex AUTO', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI, executionPermission: 'AUTO_SANDBOX',
      config: { model: 'gpt-6-sol' }, settings: '', env: [], simplified: { model: 'gpt-6-sol' }, diagnostics: [], isDefault: false,
    }} /></QueryClientProvider>)
  })
  act(() => (document.querySelector('fieldset button[aria-expanded]') as HTMLButtonElement).click())
  const auto = () => [...document.querySelectorAll<HTMLButtonElement>('fieldset button[aria-pressed]')].find(el => el.textContent?.includes('Auto approve (sandbox)'))!
  await act(async () => { await vi.waitFor(() => expect(auto().disabled).toBe(false)) })
  changeSettings('[sandbox_workspace_write]\nnetwork_access=true')
  await act(async () => { await vi.waitFor(() => expect(auto().textContent).toContain('Remove sandbox_workspace_write')) })
  expect(auto().disabled).toBe(true)
  expect(post).toHaveBeenLastCalledWith('/providers/capabilities', expect.objectContaining({ settings: '[sandbox_workspace_write]\nnetwork_access=true' }))
  changeSettings('')
  await act(async () => { await vi.waitFor(() => expect(auto().disabled).toBe(false)) })
})
