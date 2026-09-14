// @vitest-environment happy-dom
import { createRoot, type Root } from 'react-dom/client'
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { AppRootBoundary } from '../AppRootBoundary'
import { AppShellBoundary } from '../AppShellBoundary'
import { LogViewBoundary } from '../LogViewBoundary'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (source: string, values?: Record<string, unknown>) => Object.entries(values ?? {})
      .reduce((result, [key, value]) => result.replaceAll(`{${key}}`, String(value)), source),
  }),
  // `AppShellBoundary` must render without the i18n context and therefore uses
  // the module-level helper instead of `useI18n`.
  translate: (source: string) => source,
}))

function Boom({ message }: { message: string }): ReactNode {
  throw new Error(message)
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent?.includes(label))
}

describe('render error fallbacks', () => {
  let container: HTMLDivElement
  let root: Root
  let consoleErrorSpy: MockInstance<typeof console.error>

  const loggedEntries = () => consoleErrorSpy.mock.calls
    .filter((call) => typeof call[0] === 'string' && (call[0] as string).includes('[error-log]'))

  beforeEach(() => {
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

  it('keeps the page alive, shows a retryable fallback and records the error', async () => {
    await act(async () => {
      root.render(
        <div>
          <p>page chrome</p>
          <LogViewBoundary>
            <Boom message="boom from log view" />
          </LogViewBoundary>
        </div>,
      )
    })

    // The crash is contained: the rest of the page is still rendered.
    expect(container.textContent).toContain('page chrome')

    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain('Failed to display logs')
    expect(alert?.textContent).toContain('boom from log view')
    expect(findButton(container, 'Retry')).toBeDefined()

    // The error is written to the error log, not swallowed.
    const logged = loggedEntries()
    expect(logged).toHaveLength(1)
    expect(String(logged[0]?.[0])).toContain('[error-log] log-view')
    const entry = logged[0]?.[1] as { source?: string; name?: string; message?: string; time?: string }
    expect(entry.source).toBe('log-view')
    expect(entry.name).toBe('Error')
    expect(entry.message).toBe('boom from log view')
    expect(typeof entry.time).toBe('string')
  })

  it('renders the crashed subtree again after retry', async () => {
    let shouldThrow = true

    function FlakyLogView(): ReactNode {
      if (shouldThrow) throw new Error('transient log failure')
      return <p>logs restored</p>
    }

    await act(async () => {
      root.render(
        <LogViewBoundary>
          <FlakyLogView />
        </LogViewBoundary>,
      )
    })
    expect(container.textContent).toContain('Failed to display logs')

    shouldThrow = false
    const retry = findButton(container, 'Retry')
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('logs restored')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps an app-root crash recoverable and records the error', async () => {
    await act(async () => {
      root.render(
        <AppRootBoundary>
          <Boom message="app root exploded" />
        </AppRootBoundary>,
      )
    })

    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain('app root exploded')
    expect(findButton(container, 'Reload page')).toBeDefined()

    const logged = loggedEntries()
    expect(logged).toHaveLength(1)
    expect(String(logged[0]?.[0])).toContain('[error-log] app-root')
  })

  it('renders the shell fallback without any provider and records the error', async () => {
    // No i18n/query/router provider on purpose: the shell boundary sits above
    // them and must survive when one of them is the thing that broke.
    await act(async () => {
      root.render(
        <AppShellBoundary>
          <Boom message="shell exploded" />
        </AppShellBoundary>,
      )
    })

    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain('shell exploded')
    expect(alert?.textContent).toContain('Only rendering errors are caught here')
    expect(findButton(container, 'Reload page')).toBeDefined()

    const logged = loggedEntries()
    expect(logged).toHaveLength(1)
    expect(String(logged[0]?.[0])).toContain('[error-log] app-shell')
  })
})
