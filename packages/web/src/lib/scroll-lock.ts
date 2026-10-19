import { useEffect } from 'react'

let lockCount = 0

export function acquireScrollLock() {
  lockCount++
  if (lockCount === 1) {
    document.body.style.overflow = 'hidden'
  }
}

export function releaseScrollLock() {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0) {
    document.body.style.overflow = ''
  }
}

export function getLayerCount() {
  return lockCount
}

/**
 * 打开期间占一层。SettingsDialog 靠 getLayerCount() 判断 Esc 该不该由自己处理：
 * 基于 Radix 的弹窗有自己的滚动锁，不占这一层的话，按一次 Esc 会把设置弹窗一起关掉。
 */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    acquireScrollLock()
    return () => releaseScrollLock()
  }, [active])
}
