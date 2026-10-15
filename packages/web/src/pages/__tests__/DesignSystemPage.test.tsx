// @vitest-environment happy-dom
/**
 * Smoke test for the design-system showcase (`/design-system`).
 *
 * The page mounts every component in the library, so rendering it once is a
 * cheap regression net for the whole kit: nothing throws, React reports no
 * warnings (keys, DOM nesting), anchors are unique, the table of contents
 * points at real sections, and no chart ends up with NaN geometry.
 */
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { SECTIONS } from '../design-system/sections'
import { DesignSystemPage } from '../DesignSystemPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// `I18nProvider` reads the locale through this hook; stubbing it keeps the test
// free of a query client and of network calls.
vi.mock('@/hooks/use-app-settings', () => ({
  useAppSettings: () => ({ data: { locale: 'zh-CN' } }),
  useUpdateAppSettings: () => ({ mutate: vi.fn() }),
}))

/** Charts measure their container; report a real width so they draw SVG instead of placeholders. */
class ResizeObserverStub {
  callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  observe(target: Element) {
    this.callback([{ target, contentRect: { width: 640, height: 320 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
  }

  unobserve() {}

  disconnect() {}
}

describe('DesignSystemPage', () => {
  let container: HTMLDivElement
  let root: Root
  let consoleErrorSpy: MockInstance<typeof console.error>

  beforeEach(async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    consoleErrorSpy = vi.spyOn(console, 'error')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <I18nProvider>
          <MemoryRouter initialEntries={['/design-system']}>
            <DesignSystemPage />
          </MemoryRouter>
        </I18nProvider>,
      )
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    consoleErrorSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('renders every section in table-of-contents order without React warnings', () => {
    const rendered = Array.from(container.querySelectorAll('[data-ds-section]'), node => node.id)
    expect(rendered).toEqual(SECTIONS.map(section => section.id))

    const toc = container.querySelector('nav[aria-label="设计系统目录"]')
    const entries = Array.from(toc?.querySelectorAll('button') ?? [], button => button.textContent ?? '')
    for (const section of SECTIONS) {
      expect(entries.some(entry => entry.startsWith(section.title))).toBe(true)
    }

    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('keeps element ids unique so anchors and aria references resolve', () => {
    const ids = Array.from(container.querySelectorAll('[id]'), node => node.id)
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
    expect(duplicates).toEqual([])
  })

  it('draws charts with finite geometry', () => {
    // Line, bar, stacked bar, slope and scatter charts draw at the stubbed 640px; icons are 24px and never match.
    expect(container.querySelectorAll('svg[width="640"]').length).toBeGreaterThanOrEqual(5)
    expect(container.innerHTML).not.toContain('NaN')
  })

  it('marks the table-of-contents entry as current when jumping to a section', async () => {
    const target = SECTIONS[SECTIONS.length - 1]
    const toc = container.querySelector('nav[aria-label="设计系统目录"]')
    const entry = Array.from(toc?.querySelectorAll('button') ?? []).find(button => button.textContent?.startsWith(target.title))
    expect(entry).toBeDefined()

    await act(async () => {
      entry?.click()
    })

    expect(entry?.getAttribute('aria-current')).toBe('location')
    expect(window.location.hash).toBe(`#${target.id}`)
  })
})
