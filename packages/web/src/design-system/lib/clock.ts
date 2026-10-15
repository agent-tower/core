import { useSyncExternalStore } from 'react'

/**
 * 共享时钟：所有相对时间共用一个 30 秒节拍，避免每行一个定时器，
 * 也避免在渲染期直接调用 Date.now()（渲染必须是纯的）。
 */
const TICK_MS = 30_000
let now = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!timer) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      listeners.forEach(notify => notify())
    }, TICK_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

function getNow() {
  return now
}

export function useNow() {
  return useSyncExternalStore(subscribe, getNow, getNow)
}

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

type Translate = (source: string, values?: Record<string, number>) => string

/** 侧栏紧凑相对时间：刚刚 / 3 分钟 / 2 小时 / 5 天；超过一周显示 9/23，跨年只到月 2025/9 */
export function formatRelativeTime(time: Date | number | string, current: number, t: Translate, locale?: string) {
  const date = time instanceof Date ? time : new Date(time)
  const diff = Math.max(0, Math.floor((current - date.getTime()) / 1000))
  if (diff < MINUTE) return t('now')
  if (diff < HOUR) return t('{count}m', { count: Math.floor(diff / MINUTE) })
  if (diff < DAY) return t('{count}h', { count: Math.floor(diff / HOUR) })
  if (diff < 7 * DAY) return t('{count}d', { count: Math.floor(diff / DAY) })
  const sameYear = date.getFullYear() === new Date(current).getFullYear()
  return date.toLocaleDateString(locale, sameYear ? { month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'numeric' })
}
