import { useCallback, useEffect, useRef, type RefObject } from "react"
import type { FitAddon } from "@xterm/addon-fit"
import type { Terminal as XTerm } from "xterm"

interface UseXtermAutoFitOptions {
  terminalRef: RefObject<HTMLDivElement | null>
  xtermRef: RefObject<XTerm | null>
  fitAddonRef: RefObject<FitAddon | null>
  isVisible?: boolean
  onResize: (cols: number, rows: number) => void
}

export function useXtermAutoFit({
  terminalRef,
  xtermRef,
  fitAddonRef,
  isVisible = true,
  onResize,
}: UseXtermAutoFitOptions) {
  const timerRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const generationRef = useRef(0)

  const clearPendingFit = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (rafRef.current != null) {
      window.cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const fitNow = useCallback(() => {
    const fitAddon = fitAddonRef.current
    const xterm = xtermRef.current
    const el = terminalRef.current

    if (!fitAddon || !xterm || !el || el.clientWidth <= 0 || el.clientHeight <= 0) {
      return false
    }

    try {
      fitAddon.fit()
      if (xterm.cols > 0 && xterm.rows > 0) {
        onResize(xterm.cols, xterm.rows)
      }
      return true
    } catch {
      return false
    }
  }, [fitAddonRef, onResize, terminalRef, xtermRef])

  const scheduleFit = useCallback((retries = 6) => {
    clearPendingFit()
    const generation = generationRef.current + 1
    generationRef.current = generation
    let attempt = 0

    const run = () => {
      if (generationRef.current !== generation) return

      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null
        if (generationRef.current !== generation) return

        const fitted = fitNow()
        const shouldSettle = attempt < 2
        if (attempt < retries && (!fitted || shouldSettle)) {
          attempt += 1
          timerRef.current = window.setTimeout(run, 50)
        }
      })
    }

    run()
  }, [clearPendingFit, fitNow])

  const cancelScheduledFit = useCallback(() => {
    generationRef.current += 1
    clearPendingFit()
  }, [clearPendingFit])

  useEffect(() => cancelScheduledFit, [cancelScheduledFit])

  useEffect(() => {
    if (!isVisible) return
    scheduleFit(8)
  }, [isVisible, scheduleFit])

  useEffect(() => {
    const el = terminalRef.current
    if (!el) return

    if (typeof ResizeObserver === "undefined") {
      scheduleFit(8)
      return
    }

    const observer = new ResizeObserver(() => {
      scheduleFit(4)
    })

    observer.observe(el)
    if (el.parentElement) {
      observer.observe(el.parentElement)
    }

    scheduleFit(8)

    return () => {
      observer.disconnect()
    }
  }, [scheduleFit, terminalRef])

  return { fitNow, scheduleFit }
}
