import { useState, useEffect, useRef, useCallback } from 'react'
import { LOADING_ANIMATIONS, REDUCED_MOTION_GLOBAL } from '@/components/loading/LoadingAnimations'
import { X } from 'lucide-react'

export function LoadingPreviewPage() {
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const focused = focusedId
    ? LOADING_ANIMATIONS.find((a) => a.id === focusedId)
    : null

  const closeDialog = useCallback(() => {
    setFocusedId(null)
  }, [])

  useEffect(() => {
    if (!focused) {
      triggerRef.current?.focus()
      triggerRef.current = null
      return
    }

    closeBtnRef.current?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeDialog()
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        closeBtnRef.current?.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [focused, closeDialog])

  return (
    <div className="min-h-screen bg-background">
      <style>{REDUCED_MOTION_GLOBAL}</style>

      {/* Header */}
      <header className="border-b border-border px-6 py-4">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-lg font-semibold text-foreground">Loading Animation Preview</h1>
          <p className="text-sm text-muted-foreground mt-1">
            10 个首屏加载动画候选 · 颜色遵循 Agent Tower 设计规范 · 点击卡片查看全屏效果
          </p>
        </div>
      </header>

      {/* Grid */}
      <main
        className="max-w-6xl mx-auto px-6 py-8"
        inert={focused ? true : undefined}
        aria-hidden={focused ? true : undefined}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {LOADING_ANIMATIONS.map((anim, idx) => {
            const Component = anim.component
            return (
              <button
                key={anim.id}
                onClick={(e) => {
                  triggerRef.current = e.currentTarget
                  setFocusedId(anim.id)
                }}
                className="group relative flex flex-col bg-card border border-border rounded-lg p-5 text-left transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <span className="absolute top-3 right-3 text-[11px] font-semibold text-muted-foreground/60 tabular-nums">
                  #{idx + 1}
                </span>

                <div className="flex items-center justify-center h-28 mb-4">
                  <Component />
                </div>

                <h3 className="text-sm font-semibold text-foreground mb-1">{anim.name}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">{anim.description}</p>
              </button>
            )
          })}
        </div>

        {/* Recommended section */}
        <div className="mt-10 p-5 border border-border rounded-lg bg-muted/30">
          <h2 className="text-sm font-semibold text-foreground mb-2">设计推荐</h2>
          <ul className="text-xs text-muted-foreground space-y-1.5 leading-relaxed">
            <li>
              <strong className="text-foreground">首选：Charcoal Breathe (#10)</strong> — 品牌感最强，Charcoal
              色块+Tower 图标呼吸，用户对产品的第一印象即品牌本身。
            </li>
            <li>
              <strong className="text-foreground">备选A：Tower Pulse (#1)</strong> — 品牌图标直接出现，脉冲节奏稳定，
              不浮夸，适合工作台场景。
            </li>
            <li>
              <strong className="text-foreground">备选B：Terminal Cursor (#4)</strong> — 终端光标闪烁，贴合
              Agent/终端协作的核心场景，开发者亲切感强。
            </li>
          </ul>
        </div>
      </main>

      {/* Fullscreen Preview Dialog */}
      {focused && (
        <div
          ref={dialogRef}
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDialog()
          }}
          role="dialog"
          aria-modal="true"
          aria-label={`全屏预览：${focused.name}`}
        >
          <button
            ref={closeBtnRef}
            onClick={closeDialog}
            className="absolute top-4 right-4 p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label="关闭预览"
          >
            <X size={20} />
          </button>

          <div className="flex flex-col items-center gap-6">
            <div className="scale-[2] origin-center">
              <focused.component />
            </div>
            <div className="text-center mt-4">
              <h3 className="text-base font-semibold text-foreground">{focused.name}</h3>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">{focused.description}</p>
            </div>
            <span className="text-xs text-muted-foreground/60 mt-2">按 Esc 或点击关闭按钮退出</span>
          </div>
        </div>
      )}
    </div>
  )
}
