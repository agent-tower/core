// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppLocale } from '@agent-tower/shared'
import { I18nProvider } from '@/lib/i18n'
import { TaskStartProgress, type TaskStartProgressState } from '../TaskStartProgress'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings = vi.hoisted(() => ({ locale: 'zh-CN' as AppLocale }))
const updateSettings = { mutate: vi.fn() }

// Use the real provider and translation dictionaries, stubbing only persistence.
vi.mock('@/hooks/use-app-settings', () => ({
  useAppSettings: () => ({ data: settings }),
  useUpdateAppSettings: () => updateSettings,
}))

describe('TaskStartProgress localization', () => {
  let container: HTMLDivElement
  let root: Root
  let previousLocale: string | null
  let previousLang: string

  beforeEach(() => {
    previousLocale = localStorage.getItem('agent-tower.locale')
    previousLang = document.documentElement.lang
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    if (previousLocale === null) localStorage.removeItem('agent-tower.locale')
    else localStorage.setItem('agent-tower.locale', previousLocale)
    document.documentElement.lang = previousLang
  })

  it.each([
    {
      locale: 'zh-CN' as const,
      title: '正在启动任务',
      steps: ['准备工作空间', '正在创建会话', '正在启动 Agent'],
      more: '更多详情',
      hide: '收起详情',
      detail: '工作空间正在后台准备。',
      failed: '启动 Agent 失败',
      retry: '重试启动 Agent',
    },
    {
      locale: 'en' as const,
      title: 'Starting task',
      steps: ['Preparing workspace', 'Creating session', 'Starting agent'],
      more: 'More details',
      hide: 'Hide details',
      detail: 'Workspace setup is running in the background.',
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
        .toBe(expected.title + expected.steps.join('') + expected.more)
    }

    await act(async () => container.querySelector('button')?.click())
    expect(container.textContent).toContain(expected.hide)
    expect(container.textContent).toContain(expected.detail)

    await render('failed')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(expected.failed)
    expect(container.textContent).toContain(expected.retry)
  })
})
