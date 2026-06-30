// @vitest-environment happy-dom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentCliEnvironmentStatus,
  AgentCliInstallPreview,
  AgentCliPublicInstallManifestItem,
} from '@agent-tower/shared'
import { AgentCliEnvironmentPanel } from '../AgentCliEnvironmentPanel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  createPreviewMutateMock,
  createTaskMutateMock,
  cancelTaskMutateMock,
  refreshStatusMutateMock,
  taskRefetchMock,
  logsRefetchMock,
} = vi.hoisted(() => ({
  createPreviewMutateMock: vi.fn(),
  createTaskMutateMock: vi.fn(),
  cancelTaskMutateMock: vi.fn(),
  refreshStatusMutateMock: vi.fn(),
  taskRefetchMock: vi.fn(),
  logsRefetchMock: vi.fn(),
}))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (source: string) => source }),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('@/hooks/use-agent-cli-environment', () => ({
  useAgentCliManifest: () => ({
    data: manifest,
    isLoading: false,
    isError: false,
  }),
  useAgentCliStatus: () => ({
    data: status,
    isLoading: false,
    isError: false,
  }),
  useRefreshAgentCliStatus: () => ({
    mutate: refreshStatusMutateMock,
    isPending: false,
  }),
  useCreateAgentCliInstallPreview: () => ({
    mutate: createPreviewMutateMock,
    isPending: false,
  }),
  useCreateAgentCliInstallTask: () => ({
    mutate: createTaskMutateMock,
    isPending: false,
    data: undefined,
  }),
  useCancelAgentCliInstallTask: () => ({
    mutate: cancelTaskMutateMock,
    isPending: false,
  }),
  useAgentCliInstallTask: () => ({
    data: undefined,
    refetch: taskRefetchMock,
  }),
  useAgentCliInstallLogs: () => ({
    data: { taskId: 'task-1', entries: [], nextSeq: 0, truncated: false },
    refetch: logsRefetchMock,
  }),
}))

function downloadedScriptTool(
  id: AgentCliPublicInstallManifestItem['id'],
  displayName: string,
): AgentCliPublicInstallManifestItem {
  return {
    id,
    displayName,
    description: `${displayName} CLI`,
    legacy: false,
    officialSources: [{ label: `${displayName} docs`, url: `https://example.com/${id}` }],
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    install: {
      kind: 'downloaded-script',
      downloadUrl: `https://example.com/${id}/install.sh`,
      allowedRedirectHosts: ['example.com'],
      allowedExactPaths: [`/${id}/install.sh`],
      allowedPathPrefixes: [],
      interpreters: { darwin: { command: 'sh', args: [] } },
      fixedArgs: [],
      maxBytes: 1024,
      riskNotes: ['Runs an official installer script.'],
    },
    detectionCommands: [{ command: displayName.toLowerCase(), args: ['--version'], timeoutMs: 1000 }],
    lastVerifiedAt: '2026-06-18T00:00:00.000Z',
  }
}

function previewFor(toolId: AgentCliPublicInstallManifestItem['id']): AgentCliInstallPreview {
  return {
    id: `preview-${toolId}`,
    toolId,
    platform: 'darwin',
    status: 'ready',
    finalUrl: `https://example.com/${toolId}/install.sh`,
    redirectChain: [],
    sizeBytes: 256,
    sha256: '0'.repeat(64),
    interpreter: { command: 'sh', args: [] },
    fixedArgs: [],
    riskNotes: ['Runs an official installer script.'],
    createdAt: '2026-06-18T00:00:00.000Z',
    expiresAt: '2026-06-18T00:05:00.000Z',
  }
}

const manifest: AgentCliPublicInstallManifestItem[] = [
  downloadedScriptTool('codex', 'Codex'),
  downloadedScriptTool('claude-code', 'Claude Code'),
]

const status: AgentCliEnvironmentStatus = {
  checkedAt: '2026-06-18T00:00:00.000Z',
  stale: false,
  tools: manifest.map(item => ({
    toolId: item.id,
    installStatus: 'missing',
    versionStatus: 'unknown',
    version: null,
    authStatus: 'unknown',
    checkedAt: '2026-06-18T00:00:00.000Z',
    stale: false,
  })),
}

function getButton(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll('button')).find(candidate => (
    candidate.textContent?.includes(text)
  ))
  if (!button) throw new Error(`button not found: ${text}`)
  return button as HTMLButtonElement
}

describe('AgentCliEnvironmentPanel preview binding', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('ignores an old preview response after switching tools before submit', async () => {
    let codexPreviewCallbacks:
      | { onSuccess?: (preview: AgentCliInstallPreview) => void }
      | undefined

    createPreviewMutateMock.mockImplementation((toolId, callbacks) => {
      if (toolId === 'codex') {
        codexPreviewCallbacks = callbacks
      }
    })

    await act(async () => {
      root.render(<AgentCliEnvironmentPanel />)
    })

    const previewButtons = Array.from(container.querySelectorAll('button')).filter(button => (
      button.textContent?.includes('预览安装')
    )) as HTMLButtonElement[]

    await act(async () => {
      previewButtons[0].click()
    })

    await act(async () => {
      getButton(container, 'Claude Code').click()
    })

    await act(async () => {
      codexPreviewCallbacks?.onSuccess?.(previewFor('codex'))
    })

    expect(container.textContent).not.toContain('安装预览')
    expect(container.textContent).not.toContain('preview-codex')
    expect(createTaskMutateMock).not.toHaveBeenCalled()
  })
})
