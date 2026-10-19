type VisibilityListener = (visible: boolean) => void

// One observer for the list; offscreen rows keep only their ordinary DOM text.
const listeners = new Map<Element, VisibilityListener>()
const intersecting = new Set<Element>()
let observer: IntersectionObserver | undefined

function publishPageVisibility() {
  for (const element of intersecting) {
    listeners.get(element)?.(document.visibilityState !== 'hidden')
  }
}

export function observeTaskText(element: Element, listener: VisibilityListener): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {}

  if (!observer) {
    const created = new IntersectionObserver(entries => {
      if (observer !== created) return
      for (const entry of entries) {
        const notify = listeners.get(entry.target)
        if (!notify) continue
        const visible = entry.isIntersecting && entry.intersectionRatio > 0
        if (visible) intersecting.add(entry.target)
        else intersecting.delete(entry.target)
        notify(visible && document.visibilityState !== 'hidden')
      }
    })
    observer = created
    document.addEventListener('visibilitychange', publishPageVisibility)
  }

  listeners.set(element, listener)
  observer.observe(element)
  return () => {
    listeners.delete(element)
    intersecting.delete(element)
    observer?.unobserve(element)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = undefined
      document.removeEventListener('visibilitychange', publishPageVisibility)
    }
  }
}
