import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import {
  AgentType,
  PROVIDER_CAPABILITIES,
  RuntimeType,
  type AppSettings,
} from '@agent-tower/shared'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import { getProviderStartIssue } from '@/components/provider/provider-draft'
import { CreateTaskInput, type CreateTaskInputProps } from '@/components/task/CreateTaskInput'
import { queryKeys } from '@/hooks/query-keys'
import { I18nProvider } from '@/lib/i18n'
import { ProviderSettingsPage } from '../ProviderSettingsPage'
import '@/index.css'

declare global {
  interface Window {
    __PROVIDER_LAYOUT_FIXTURE_READY__?: boolean
    __SET_START_PROVIDER_CAPABILITY__?: (capabilityChanged: boolean) => void
  }
}

const providers: ProviderWithAvailability[] = [
  {
    provider: {
      id: 'codex-layout-fixture',
      name: 'Codex Provider With A Deliberately Long Display Name For Responsive Coverage',
      agentType: AgentType.CODEX,
      executionPermission: 'FULL_ACCESS',
      env: {},
      redactedEnv: {
        OPENAI_API_KEY_WITH_A_DELIBERATELY_LONG_SUFFIX_FOR_LAYOUT_COVERAGE: {
          configured: true,
          sensitive: true,
        },
      },
      config: {
        model: 'gpt-5.4-with-a-deliberately-long-model-suffix-for-layout-coverage',
        unknownConfigKeyWithALongName: 'unknown-config-value-with-a-long-unbroken-suffix',
      },
      settings: [
        '# Provider settings layout fixture',
        'openai_base_url = "https://gateway.example.test/a/deliberately/long/provider/path/v1"',
        'model_reasoning_effort = "high"',
        'unknown_setting = "keep-this-long-unknown-setting-value-for-layout-coverage"',
      ].join('\n'),
      simplified: {
        apiBaseUrl: 'https://gateway.example.test/a/deliberately/long/provider/path/v1',
        apiKey: { configured: true, envKey: 'OPENAI_API_KEY_WITH_A_DELIBERATELY_LONG_SUFFIX_FOR_LAYOUT_COVERAGE' },
        model: 'gpt-5.4-with-a-deliberately-long-model-suffix-for-layout-coverage',
        reasoningEffort: 'high',
      },
      diagnostics: [],
      isDefault: true,
      builtIn: false,
      deletable: true,
    },
    availability: { type: 'LOGIN_DETECTED' },
  },
  {
    provider: {
      id: 'claude-layout-fixture',
      name: 'Claude Fixture',
      agentType: AgentType.CLAUDE_CODE,
      executionPermission: 'FULL_ACCESS',
      env: {},
      redactedEnv: {},
      config: {},
      settings: '',
      simplified: {
        apiBaseUrl: 'https://api.anthropic.com',
        apiKey: { configured: false, envKey: 'ANTHROPIC_API_KEY' },
      },
      diagnostics: [],
      isDefault: false,
      builtIn: false,
      deletable: true,
    },
    availability: { type: 'INSTALLATION_FOUND' },
  },
  {
    provider: {
      id: 'blocked-codex-layout-fixture',
      name: 'Blocked Codex',
      agentType: AgentType.CODEX,
      executionPermission: 'AUTO_SANDBOX',
      executionPermissionOptions: [{
        mode: 'AUTO_SANDBOX', supported: false, authorized: true, selectable: false,
        reasons: [{ code: 'CONFLICT', message: 'Remove sandbox_workspace_write from Codex advanced settings before using automatic sandbox approval.' }],
      }],
      env: {},
      redactedEnv: {},
      config: { model: 'gpt-6-sol' },
      settings: '[sandbox_workspace_write]\nnetwork_access=true',
      simplified: { model: 'gpt-6-sol' },
      diagnostics: [],
      isDefault: false,
      builtIn: false,
      deletable: true,
    },
    availability: { type: 'LOGIN_DETECTED' },
  },
]

const appSettings: AppSettings = {
  id: 'default',
  locale: 'zh-CN',
  commitMessageProviderId: null,
  commitMessagePrompt: null,
}

const capabilities = Object.fromEntries(Object.entries(PROVIDER_CAPABILITIES).map(([agent, capability]) => [agent, {
  ...capability, executionPermissionOptions: {
    CLI: [
      { mode: 'ASK', supported: false, authorized: true, selectable: false, reasons: [{ code: 'RUNTIME_MODE_UNSUPPORTED', message: 'The current headless CLI integration cannot forward native approval requests. Use ACP.' }] },
      { mode: 'AUTO_SANDBOX', supported: false, authorized: true, selectable: false, reasons: [{ code: 'CAPABILITY_UNVERIFIED', message: 'A native sandbox mode has not been verified for this integration.' }] },
      { mode: 'FULL_ACCESS', supported: true, authorized: true, selectable: true, reasons: [] },
    ],
  },
}]))

const originalFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const requestUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url
  const url = new URL(requestUrl, window.location.origin)

  if (url.pathname === '/api/providers' && (!init?.method || init.method === 'GET')) {
    return Response.json(providers)
  }
  if (url.pathname === '/api/providers/capabilities') {
    return Response.json(capabilities)
  }
  if (url.pathname === '/api/app-settings') {
    return Response.json(appSettings)
  }
  return originalFetch(input, init)
}

window.localStorage.setItem('agent-tower.locale', 'zh-CN')

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: Infinity },
    mutations: { retry: false },
  },
})

// Preload edit capabilities so loading diagnostics cannot open Advanced before layout measurements.
for (const { provider } of providers) {
  queryClient.setQueryData(queryKeys.providers.capabilities(
    provider.agentType, provider.simplified?.model, provider.id, provider.runtimeType ?? RuntimeType.CLI,
    provider.config, provider.settings,
  ), capabilities)
}

const root = createRoot(document.getElementById('root')!)
const isStartFixture = new URLSearchParams(window.location.search).has('start')
if (isStartFixture) {
  const renderStart = (capabilityChanged: boolean) => {
    const options: CreateTaskInputProps['providers'] = providers.map(item => {
      const reason = item.provider.id === 'codex-layout-fixture' && capabilityChanged
        ? 'Native approval unavailable after refresh'
        : item.provider.id === 'blocked-codex-layout-fixture' && capabilityChanged
          ? undefined
          : getProviderStartIssue(item)
      return {
        id: item.provider.id,
        name: item.provider.name,
        agentType: item.provider.agentType,
        available: !reason,
        permissionMode: item.provider.executionPermission,
        reason,
      }
    })
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <main className="mx-auto max-w-2xl px-4 pt-12">
            <CreateTaskInput variant="conversation" projects={[]} providers={options}
              defaultProviderId={capabilityChanged ? 'blocked-codex-layout-fixture' : 'codex-layout-fixture'}
              createStep="idle" onSubmit={async () => {}} />
          </main>
        </I18nProvider>
      </QueryClientProvider>,
    )
  }
  window.__SET_START_PROVIDER_CAPABILITY__ = renderStart
  renderStart(false)
} else {
  root.render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ProviderSettingsPage />
      </I18nProvider>
    </QueryClientProvider>,
  )
}

window.__PROVIDER_LAYOUT_FIXTURE_READY__ = true
