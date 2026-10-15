import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react'

/**
 * 测量元素宽度（callback ref）。图表按真实像素宽度绘制，文字不随容器缩放。
 * ResizeObserver 首次 observe 时会回调一次当前尺寸；不支持 RO 的环境（测试）退回 fallback。
 */
export function useElementWidth<T extends HTMLElement>(fallback = 480) {
  const [node, setNode] = useState<T | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0)
      setWidth(prev => (prev === next ? prev : next))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  const supportsObserver = typeof ResizeObserver !== 'undefined'
  return [setNode, width || (supportsObserver ? 0 : fallback)] as const
}

/** 受控 / 非受控两用的状态：传 value 即受控，否则内部维护 */
export function useControllableState<T>({
  value,
  defaultValue,
  onChange,
}: {
  value?: T
  defaultValue: T
  onChange?: (value: T) => void
}) {
  const [inner, setInner] = useState(defaultValue)
  const isControlled = value !== undefined
  const current = isControlled ? (value as T) : inner
  const setValue = useCallback((next: T) => {
    if (!isControlled) setInner(next)
    onChange?.(next)
  }, [isControlled, onChange])
  return [current, setValue] as const
}

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const query = window.matchMedia('(prefers-reduced-motion: reduce)')
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function getReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** 是否开启「减少动态效果」：JS 驱动的动画（平滑滚动、计数等）据此降级 */
export function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, getReducedMotion, () => false)
}

/** SVG 内部引用（pattern / gradient）用的 id：去掉 useId 里的 «» : 等字符，保证 url(#id) 在各浏览器可用 */
export function useSvgId(prefix: string) {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
}
