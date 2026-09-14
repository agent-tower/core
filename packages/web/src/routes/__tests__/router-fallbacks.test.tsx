// @vitest-environment happy-dom
/**
 * Fallback tests for the *production* route tree.
 *
 * The route objects come from the production route table (`routes/app-routes.tsx`,
 * the module `AppRouter` builds the browser router from), so these cases
 * exercise the real hierarchy: root route -> `RootLayout` -> pathless grouping
 * route -> page. Only the leaves are mocked (a page that throws, a `RootLayout`
 * that can be made to throw), which is what lets one test prove the grouping
 * fallback and the other prove the root fallback.
 */
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { appRoutes } from '../app-routes'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const flags = vi.hoisted(() => ({
  demoPageThrows: true,
  rootLayoutThrows: false,
}))

// `I18nProvider` reads the locale through this hook; stubbing it keeps the test
// free of a query client and of network calls.
vi.mock('@/hooks/use-app-settings', () => ({
  useAppSettings: () => ({ data: { locale: 'en' } }),
  useUpdateAppSettings: () => ({ mutate: vi.fn() }),
}))

// `AgentCliOnboarding` lives in `RootLayout` and is irrelevant to error
// routing; keep it inert instead of giving it a real status query.
vi.mock('@/hooks/use-agent-cli-environment', () => ({
  useAgentCliStatus: () => ({ data: undefined }),
  useRefreshAgentCliStatus: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/pages/ProjectKanbanPage', () => ({
  ProjectKanbanPage: () => <p>task board page</p>,
}))

vi.mock('@/pages/DemoPage', () => ({
  DemoPage: () => {
    if (flags.demoPageThrows) throw new Error('demo page exploded')
    return <p>demo page</p>
  },
}))

// The real layout by default; flipped to throwing for the root-fallback case.
vi.mock('@/layouts/RootLayout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layouts/RootLayout')>()
  return {
    RootLayout: () => {
      if (flags.rootLayoutThrows) throw new Error('root layout exploded')
      return <actual.RootLayout />
    },
  }
})

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent?.includes(label))
}

describe('production route tree fallbacks', () => {
  let container: HTMLDivElement
  let root: Root
  let consoleErrorSpy: MockInstance<typeof console.error>

  const loggedEntries = () => consoleErrorSpy.mock.calls
    .filter((call) => typeof call[0] === 'string' && (call[0] as string).includes('[error-log]'))

  /** Lazy route modules settle asynchronously; poll instead of guessing ticks. */
  const waitForText = (text: string) => vi.waitFor(() => {
    expect(container.textContent).toContain(text)
  })

  const renderAt = async (path: string) => {
    const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
    await act(async () => {
      root.render(
        <I18nProvider>
          <RouterProvider router={router} />
        </I18nProvider>,
      )
    })
    return router
  }

  beforeEach(() => {
    flags.demoPageThrows = true
    flags.rootLayoutThrows = false
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    consoleErrorSpy.mockRestore()
  })

  it('keeps RootLayout and shows the pathless-group fallback when a page throws', async () => {
    await renderAt('/demo')
    await waitForText('demo page exploded')

    // The fallback is rendered *inside* RootLayout's chrome, i.e. by the
    // pathless grouping route's `errorElement` - not by the root one.
    const rootLayoutChrome = container.querySelector('div.min-h-screen')
    expect(rootLayoutChrome).not.toBeNull()
    const alert = rootLayoutChrome?.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain('Something went wrong')
    expect(alert?.textContent).toContain('demo page exploded')

    const logged = loggedEntries()
    expect(logged).toHaveLength(1)
    expect(String(logged[0]?.[0])).toContain('[error-log] router.errorElement')

    // The failed page does not poison the rest of the tree: navigating home
    // renders the (healthy) index route.
    const back = findButton(container, 'Back to home')
    expect(back).toBeDefined()
    await act(async () => {
      back?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitForText('task board page')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows the root fallback when RootLayout itself throws', async () => {
    flags.rootLayoutThrows = true

    await renderAt('/demo')
    await waitForText('root layout exploded')

    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain('Something went wrong')
    expect(alert?.textContent).toContain('root layout exploded')
    // RootLayout was replaced entirely, so its chrome is gone.
    expect(container.querySelector('div.min-h-screen')).toBeNull()
    expect(findButton(container, 'Back to home')).toBeDefined()

    const logged = loggedEntries()
    expect(logged).toHaveLength(1)
    expect(String(logged[0]?.[0])).toContain('[error-log] router.errorElement')
  })
})
