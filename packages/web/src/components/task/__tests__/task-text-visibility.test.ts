// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeTaskText } from '../task-text-visibility'

class MockObserver {
  static instances: MockObserver[] = []
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  private callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    MockObserver.instances.push(this)
  }
  emit(target: Element, visible: boolean) {
    this.callback([{ target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

const cleanups: Array<() => void> = []
beforeEach(() => {
  MockObserver.instances = []
  vi.stubGlobal('IntersectionObserver', MockObserver)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('task text visibility', () => {
  it('shares one observer across a large list and suspends only visible text when backgrounded', () => {
    const rows = Array.from({ length: 1000 }, () => ({ element: document.createElement('span'), notify: vi.fn() }))
    for (const { element, notify } of rows) cleanups.push(observeTaskText(element, notify))
    expect(MockObserver.instances).toHaveLength(1)
    const observer = MockObserver.instances[0]
    observer.emit(rows[0].element, true)
    observer.emit(rows[1].element, true)
    expect(rows[0].notify).toHaveBeenLastCalledWith(true)

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(rows[0].notify).toHaveBeenLastCalledWith(false)
    expect(rows[1].notify).toHaveBeenLastCalledWith(false)
    expect(rows[999].notify).not.toHaveBeenCalled()

    observer.emit(rows[1].element, false)
    rows[1].notify.mockClear()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(rows[0].notify).toHaveBeenLastCalledWith(true)
    expect(rows[1].notify).not.toHaveBeenCalled()

    for (const cleanup of cleanups.splice(0)) cleanup()
    expect(observer.unobserve).toHaveBeenCalledTimes(1000)
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
  })

  it('ignores late notifications after disposal and observer recreation', () => {
    const element = document.createElement('span')
    const oldListener = vi.fn()
    const dispose = observeTaskText(element, oldListener)
    const oldObserver = MockObserver.instances[0]
    dispose()

    const newListener = vi.fn()
    cleanups.push(observeTaskText(element, newListener))
    oldObserver.emit(element, true)
    expect(oldListener).not.toHaveBeenCalled()
    expect(newListener).not.toHaveBeenCalled()
    MockObserver.instances[1].emit(element, true)
    expect(newListener).toHaveBeenCalledWith(true)
  })

  it('keeps the ordinary text fallback when visibility observation is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const notify = vi.fn()
    cleanups.push(observeTaskText(document.createElement('span'), notify))
    expect(notify).not.toHaveBeenCalled()
    expect(MockObserver.instances).toHaveLength(0)
  })
})
