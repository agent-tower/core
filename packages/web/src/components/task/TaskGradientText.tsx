import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { fitTaskText } from './task-text-fit'
import { observeTaskText } from './task-text-visibility'

type Variant = 'running' | 'project'
const CYCLE_MS = 4200
const SWEEP_MS = CYCLE_MS * 0.4
const FRAME_MS = 1000 / 30

function getContext(canvas: HTMLCanvasElement | null) {
  try {
    return canvas?.getContext('2d') ?? null
  } catch {
    return null
  }
}

function GradientCanvas({
  hostRef, text, variant, animate,
}: {
  hostRef: RefObject<HTMLSpanElement | null>
  text: string
  variant: Variant
  animate: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    const context = getContext(canvas)
    if (!host || !canvas || !context) return

    const row = host.closest('.task-row')
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
    const hover = matchMedia('(hover: hover)')
    let frame = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let startedAt = 0
    let lastFrame = 0
    let width = 0
    let height = 0
    let baseline = 0
    let fontSize = 0
    let color = ''
    let mutedColor = ''
    let fittedText = ''
    let disposed = false

    function stop() {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      frame = 0
      timer = undefined
    }

    function paint(progress: number) {
      if (!context || !host) return
      context.clearRect(0, 0, width, height)
      context.globalCompositeOperation = 'source-over'
      if (variant === 'project') {
        const gradient = context.createLinearGradient(fontSize * 0.6, 0, fontSize * 2.6, 0)
        gradient.addColorStop(0, color)
        gradient.addColorStop(1, mutedColor)
        context.fillStyle = gradient
      } else {
        context.fillStyle = color
      }
      context.fillText(fittedText, 0, baseline)

      if (variant === 'running' && progress < 1) {
        const start = (-1.5 + 1.5 * progress) * width
        const gradient = context.createLinearGradient(start, 0, start + width * 2.5, 0)
        // ds-allow hex: destination-in 遮罩只取透明度，颜色值不会显示
        const mask = (alpha: number) => `rgba(0, 0, 0, ${alpha})`
        gradient.addColorStop(0, mask(1))
        gradient.addColorStop(0.4, mask(1))
        gradient.addColorStop(0.5, mask(0.4))
        gradient.addColorStop(0.6, mask(1))
        gradient.addColorStop(1, mask(1))
        context.globalCompositeOperation = 'destination-in'
        context.fillStyle = gradient
        context.fillRect(0, 0, width, height)
        context.globalCompositeOperation = 'source-over'
      }
      host.dataset.gradientReady = 'true'
    }

    function tick(now: number) {
      if (disposed) return
      const elapsed = (now - startedAt) % CYCLE_MS
      if (now - lastFrame >= FRAME_MS) {
        paint(Math.min(elapsed / SWEEP_MS, 1))
        lastFrame = now
      }
      if (elapsed >= SWEEP_MS) {
        // The remaining 60% of the cycle is static; schedule no animation frames.
        paint(1)
        timer = setTimeout(() => { frame = requestAnimationFrame(tick) }, CYCLE_MS - elapsed)
      } else {
        frame = requestAnimationFrame(tick)
      }
    }

    function refresh() {
      stop()
      if (!host || !canvas || !context || disposed) return
      delete host.dataset.gradientReady
      width = host.clientWidth
      height = host.clientHeight
      if (!width || !height) return

      const style = getComputedStyle(host)
      const ratio = Math.min(window.devicePixelRatio || 1, 3)
      canvas.width = Math.ceil(width * ratio)
      canvas.height = Math.ceil(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      context.textBaseline = 'alphabetic'
      fontSize = Number.parseFloat(style.fontSize)
      const metrics = context.measureText('Mg')
      const ascent = metrics.fontBoundingBoxAscent ?? fontSize * 0.8
      const descent = metrics.fontBoundingBoxDescent ?? fontSize * 0.2
      baseline = (height - ascent - descent) / 2 + ascent
      color = style.color
      mutedColor = style.getPropertyValue('--muted-foreground').trim() || color
      fittedText = fitTaskText(text, width, value => context.measureText(value).width)

      try {
        paint(1)
      } catch {
        // Unsupported canvas colors/context: the original DOM text stays visible.
        return
      }
      const paused = reducedMotion.matches || row?.matches(':focus-visible')
        || (hover.matches && row?.matches(':hover'))
      if (variant === 'running' && animate && !paused) {
        startedAt = performance.now()
        lastFrame = 0
        frame = requestAnimationFrame(tick)
      }
    }

    const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(refresh)
    resizeObserver?.observe(host)
    const themeObserver = new MutationObserver(refresh)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    themeObserver.observe(host, { attributes: true, attributeFilter: ['class', 'style'] })
    const handleContextLost = () => { stop(); delete host.dataset.gradientReady }
    canvas.addEventListener('contextlost', handleContextLost)
    canvas.addEventListener('contextrestored', refresh)
    reducedMotion.addEventListener('change', refresh)
    hover.addEventListener('change', refresh)
    for (const event of ['pointerenter', 'pointerleave', 'focus', 'blur']) row?.addEventListener(event, refresh)
    window.addEventListener('resize', refresh)
    document.fonts?.addEventListener('loadingdone', refresh)
    refresh()

    return () => {
      disposed = true
      stop()
      resizeObserver?.disconnect()
      themeObserver.disconnect()
      reducedMotion.removeEventListener('change', refresh)
      hover.removeEventListener('change', refresh)
      for (const event of ['pointerenter', 'pointerleave', 'focus', 'blur']) row?.removeEventListener(event, refresh)
      window.removeEventListener('resize', refresh)
      document.fonts?.removeEventListener('loadingdone', refresh)
      canvas.removeEventListener('contextlost', handleContextLost)
      canvas.removeEventListener('contextrestored', refresh)
      delete host.dataset.gradientReady
      // Release the backing store immediately when a row leaves the viewport.
      canvas.width = 0
      canvas.height = 0
    }
  }, [hostRef, text, variant, animate])

  return <canvas ref={canvasRef} className="task-gradient-text__canvas" aria-hidden="true" />
}

/** Preserve real text for layout/accessibility; paint only a small visible overlay. */
export function TaskGradientText({ text, variant, animate = true, className }: {
  text: string
  variant: Variant
  animate?: boolean
  className?: string
}) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!hostRef.current) return
    return observeTaskText(hostRef.current, setVisible)
  }, [])

  return (
    <span ref={hostRef} className={cn('task-gradient-text', className)} data-text-effect={variant}>
      <span className="task-gradient-text__text">{text}</span>
      {visible && <GradientCanvas hostRef={hostRef} text={text} variant={variant} animate={animate} />}
    </span>
  )
}
