// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppLocale } from '@agent-tower/shared'
import { ServerEvents, type WorkspaceSetupProgressPayload } from '@agent-tower/shared/socket'
import { I18nProvider } from '@/lib/i18n'
import { useWorkspaceSetupProgress } from '@/lib/socket/hooks/useWorkspaceSetupProgress'
import { TaskStartProgress, type TaskStartProgressState } from '../TaskStartProgress'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings = vi.hoisted(() => ({ locale: 'zh-CN' as AppLocale }))
const updateSettings = { mutate: vi.fn() }
const apiGet = vi.hoisted(() => vi.fn())
let queryClient: QueryClient
const serverProgress = new Map<string, WorkspaceSetupProgressPayload>()
notifyManager.setScheduler(callback => callback())
afterAll(() => notifyManager.setScheduler(callback => setTimeout(callback, 0)))
const socket = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: WorkspaceSetupProgressPayload) => void>>()
  return {
    on(event: string, handler: (payload: WorkspaceSetupProgressPayload) => void) {
      const listeners = handlers.get(event) ?? new Set()
      listeners.add(handler)
      handlers.set(event, listeners)
    },
    off(event: string, handler: (payload: WorkspaceSetupProgressPayload) => void) {
      handlers.get(event)?.delete(handler)
    },
    dispatch(event: string, payload?: WorkspaceSetupProgressPayload) {
      for (const handler of handlers.get(event) ?? []) handler(payload!)
    },
    reset() { handlers.clear() },
  }
})

// Use the real provider and translation dictionaries, stubbing only persistence.
vi.mock('@/hooks/use-app-settings', () => ({
  useAppSettings: () => ({ data: settings }),
  useUpdateAppSettings: () => updateSettings,
}))

vi.mock('@/lib/socket/manager', () => ({
  socketManager: { connect: () => socket },
}))
vi.mock('@/lib/api-client', () => ({ apiClient: { get: apiGet } }))

function StartupContent({
  taskId = 'task-1',
  state = null,
  sessionStarted = false,
  output = '',
}: {
  taskId?: string
  state?: TaskStartProgressState | null
  sessionStarted?: boolean
  output?: string
}) {
  const setupProgress = useWorkspaceSetupProgress(taskId)
  return (
    <I18nProvider>
      <TaskStartProgress key={taskId} state={state} setupProgress={setupProgress} sessionStarted={sessionStarted} />
      <div data-agent-output>{output}</div>
    </I18nProvider>
  )
}

function StartupHarness(props: ComponentProps<typeof StartupContent>) {
  return <QueryClientProvider client={queryClient}><StartupContent {...props} /></QueryClientProvider>
}

describe('TaskStartProgress', () => {
  let container: HTMLDivElement
  let root: Root
  let previousLocale: string | null
  let previousLang: string

  beforeEach(() => {
    socket.reset()
    serverProgress.clear()
    apiGet.mockReset().mockImplementation(async (url: string) => (
      [...serverProgress.values()].filter(progress => url === `/tasks/${progress.taskId}/setup-progress`)
    ))
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    settings.locale = 'en'
    previousLocale = localStorage.getItem('agent-tower.locale')
    previousLang = document.documentElement.lang
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    queryClient.clear()
    container.remove()
    if (previousLocale === null) localStorage.removeItem('agent-tower.locale')
    else localStorage.setItem('agent-tower.locale', previousLocale)
    document.documentElement.lang = previousLang
    vi.useRealTimers()
  })

  it.each([
    {
      locale: 'zh-CN' as const,
      steps: ['准备工作空间', '正在创建会话', '正在启动 Agent'],
      failed: '启动 Agent 失败',
      retry: '重试启动 Agent',
    },
    {
      locale: 'en' as const,
      steps: ['Preparing workspace', 'Creating session', 'Starting agent'],
      failed: 'Agent start failed',
      retry: 'Retry start',
    },
  ])('renders all startup phases and failure actions in $locale', async (expected) => {
    settings.locale = expected.locale
    const render = async (status: TaskStartProgressState['status']) => {
      await act(async () => {
        root.render(
          <I18nProvider>
            <TaskStartProgress state={{ status }} onRetry={() => {}} />
          </I18nProvider>,
        )
      })
    }

    for (const phase of ['creating-workspace', 'creating-session', 'starting-session'] as const) {
      await render(phase)
      expect(container.querySelector('[role="status"]')?.textContent)
        .toContain(expected.steps.join(''))
      expect(container.textContent).not.toContain('More details')
      expect(container.textContent).not.toContain('正在启动任务')
    }

    await render('failed')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(expected.failed)
    expect(container.textContent).toContain(expected.retry)
  })

  const setupEvent = (status: WorkspaceSetupProgressPayload['status'], taskId = 'task-1', output?: string) => {
    const payload: WorkspaceSetupProgressPayload = {
      workspaceId: 'workspace-1',
      taskId,
      status,
      updatedAt: Date.now(),
      totalCommands: 1,
      ...(status === 'running' ? { currentIndex: 1, currentCommand: 'pnpm install' } : {}),
      ...(status === 'failed' ? { error: 'Setup process failed' } : {}),
      ...(output ? { output } : {}),
    }
    serverProgress.set(payload.workspaceId, payload)
    act(() => socket.dispatch(ServerEvents.WORKSPACE_SETUP_PROGRESS, payload))
  }

  it('shows the configured setup command before any progress event arrives', async () => {
    await act(async () => root.render(<StartupHarness state={{ status: 'creating-workspace', setupScript: 'pnpm install\npnpm db:generate' }} />))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Run setup script')
    expect(container.querySelector('code')?.textContent).toBe('pnpm install\npnpm db:generate')
    expect(container.querySelector('button')).toBeNull()
  })

  it('keeps the same card and visible setup command alongside output until setup completes', async () => {
    vi.useFakeTimers()
    await act(async () => root.render(<StartupHarness state={{ status: 'starting-session' }} />))
    setupEvent('running', 'task-1', 'setup partial output')
    const card = container.querySelector('[role="status"]')
    expect(card?.textContent).toContain('Running setup (1/1)')
    expect(card?.querySelector('code')?.textContent).toBe('pnpm install')
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('setup partial output')
    await act(async () => container.querySelector('button')?.click())
    expect(container.textContent).toContain('setup partial output')

    await act(async () => root.render(<StartupHarness sessionStarted output="Agent is inspecting files" />))
    expect(container.querySelector('[role="status"]')).toBe(card)
    expect(card?.querySelector('code')?.textContent).toBe('pnpm install')
    const output = container.querySelector('[data-agent-output]')
    expect(output?.textContent).toBe('Agent is inspecting files')

    // Completion is shown briefly with its output, then the card disappears.
    setupEvent('completed', 'task-1', 'setup complete\nall good')
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    act(() => vi.advanceTimersByTime(3000))
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('[data-agent-output]')).toBe(output)
    expect(output?.textContent).toBe('Agent is inspecting files')
  })

  it('shows setup output briefly after setup finishes, then removes the card', async () => {
    vi.useFakeTimers()
    await act(async () => root.render(<StartupHarness state={{ status: 'creating-session' }} />))
    setupEvent('running')
    setupEvent('completed', 'task-1', 'setup complete')
    await act(async () => root.render(<StartupHarness sessionStarted output="Ready" />))
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    expect(container.textContent).toContain('Setup complete')
    await act(async () => container.querySelector('button')?.click())
    expect(container.textContent).toContain('setup complete')
    act(() => vi.advanceTimersByTime(3000))
    expect(container.querySelector('[role="status"]')).toBeNull()

    expect(container.textContent).toBe('Ready')
  })

  it('removes the card after startup when no setup script is running', async () => {
    await act(async () => root.render(<StartupHarness state={{ status: 'starting-session' }} />))
    await act(async () => root.render(<StartupHarness sessionStarted />))
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('does not synthesize a running card when only a completion event arrives', async () => {
    vi.useFakeTimers()
    await act(async () => root.render(<StartupHarness sessionStarted />))
    setupEvent('completed', 'task-1', 'setup complete')
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    act(() => vi.advanceTimersByTime(3000))
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('keeps progress scoped to its task and restores running setup when returning', async () => {
    await act(async () => root.render(<StartupHarness />))
    setupEvent('running')
    expect(container.querySelector('[role="status"]')).not.toBeNull()

    await act(async () => root.render(<StartupHarness taskId="task-2" />))
    expect(container.querySelector('[role="status"]')).toBeNull()
    setupEvent('running', 'task-1')
    expect(container.querySelector('[role="status"]')).toBeNull()
    await act(async () => root.render(<StartupHarness />))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('pnpm install')
  })

  it('recovers setup that began before mounting and a completion missed while disconnected', async () => {
    setupEvent('running')
    await act(async () => root.render(<StartupHarness sessionStarted output="Agent output" />))
    expect(container.querySelector('code')?.textContent).toBe('pnpm install')

    const running = serverProgress.get('workspace-1')!
    serverProgress.set('workspace-1', { ...running, status: 'completed', updatedAt: running.updatedAt + 1 })
    await act(async () => socket.dispatch('connect'))
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    expect(container.textContent).not.toContain('old command')
    expect(container.textContent).toContain('Agent output')
  })

  it('does not overwrite a completion event with an older in-flight snapshot', async () => {
    let resolve!: (progress: WorkspaceSetupProgressPayload[]) => void
    apiGet.mockImplementationOnce(() => new Promise<WorkspaceSetupProgressPayload[]>(done => { resolve = done }))
    await act(async () => root.render(<StartupHarness sessionStarted />))
    setupEvent('completed')
    const completed = serverProgress.get('workspace-1')!
    await act(async () => resolve([{ ...completed, status: 'running', updatedAt: completed.updatedAt - 1, currentCommand: 'old command' }]))
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    expect(container.textContent).not.toContain('old command')
  })

  it('shows setup failure in the card and cancels its cleanup when another setup starts', async () => {
    vi.useFakeTimers()
    await act(async () => root.render(<StartupHarness sessionStarted />))
    setupEvent('failed')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Setup process failed')
    expect(container.textContent).not.toContain('Agent start failed')

    act(() => vi.advanceTimersByTime(2000))
    setupEvent('running')
    act(() => vi.advanceTimersByTime(2000))
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    setupEvent('failed')
    act(() => vi.advanceTimersByTime(3000))
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
