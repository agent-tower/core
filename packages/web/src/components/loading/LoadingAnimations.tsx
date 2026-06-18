/**
 * 10 首屏加载动画候选方案
 *
 * 所有颜色遵循 .design/DESIGN.md 规范：
 * - 主色 Charcoal #181e25 (--primary / --brand)
 * - 中性灰 --muted-foreground / --border
 * - 不使用随机渐变或品牌外彩色
 *
 * 无障碍：所有循环动画在 prefers-reduced-motion: reduce 下停止，
 * 保留静态图形和文案。
 */

import logoUrl from '@/assets/agent-tower-logo.png'

const REDUCED_MOTION_GLOBAL = `
@media (prefers-reduced-motion: reduce) {
  .loading-anim-area,
  .loading-anim-area * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`

/* ─── #1 Tower Pulse ─── */
export function TowerPulse() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative w-10 h-10 loading-anim-area">
        <svg viewBox="0 0 24 24" fill="none" className="w-10 h-10 text-primary">
          <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="currentColor" className="animate-pulse motion-reduce:animate-none" />
          <path
            d="M2 17L12 22L22 17"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="opacity-40"
          />
          <path
            d="M2 12L12 17L22 12"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="opacity-60"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-primary animate-ping motion-reduce:animate-none opacity-40" />
        </div>
      </div>
      <span className="text-sm text-muted-foreground animate-pulse motion-reduce:animate-none">Loading</span>
    </div>
  )
}

/* ─── #2 Stack Rise ─── */
export function StackRise() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-end gap-1 h-8 loading-anim-area">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="w-1.5 bg-primary/80 rounded-full"
            style={{
              animation: `stackRise 1.2s ease-in-out ${i * 0.15}s infinite`,
              height: '8px',
            }}
          />
        ))}
      </div>
      <span className="text-sm text-muted-foreground">Loading</span>
      <style>{`
        @keyframes stackRise {
          0%, 100% { height: 8px; opacity: 0.4; }
          50% { height: 28px; opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes stackRise {
            0%, 100% { height: 16px; opacity: 0.7; }
          }
        }
      `}</style>
    </div>
  )
}

/* ─── #3 Orbit Ring ─── */
export function OrbitRing() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative w-10 h-10 loading-anim-area">
        <div className="absolute inset-0 border-2 border-border rounded-full" />
        <div
          className="absolute inset-0 border-2 border-transparent border-t-primary rounded-full"
          style={{ animation: 'orbitSpin 1s cubic-bezier(0.4, 0, 0.2, 1) infinite' }}
        />
        <div className="absolute inset-[6px] border border-border/60 rounded-full" />
        <div
          className="absolute inset-[6px] border border-transparent border-b-primary/60 rounded-full"
          style={{ animation: 'orbitSpin 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite reverse' }}
        />
      </div>
      <span className="text-sm text-muted-foreground">Loading</span>
      <style>{`
        @keyframes orbitSpin {
          to { transform: rotate(360deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes orbitSpin {
            to { transform: rotate(0deg); }
          }
        }
      `}</style>
    </div>
  )
}

/* ─── #4 Terminal Cursor ─── */
export function TerminalCursor() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center gap-0.5 px-4 py-2 bg-primary rounded-lg loading-anim-area">
        <span className="text-primary-foreground text-xs font-mono tracking-wider">loading</span>
        <span
          className="inline-block w-[7px] h-4 bg-primary-foreground/80 ml-0.5"
          style={{ animation: 'termBlink 1s steps(1) infinite' }}
        />
      </div>
      <style>{`
        @keyframes termBlink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes termBlink {
            0%, 100% { opacity: 0.8; }
          }
        }
      `}</style>
    </div>
  )
}

/* ─── #5 Dot Wave ─── */
export function DotWave() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center gap-2 loading-anim-area">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="w-2.5 h-2.5 rounded-full bg-primary"
            style={{
              animation: `dotWave 1.4s ease-in-out ${i * 0.2}s infinite`,
            }}
          />
        ))}
      </div>
      <span className="text-sm text-muted-foreground">Loading</span>
      <style>{`
        @keyframes dotWave {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.3; }
          40% { transform: scale(1); opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes dotWave {
            0%, 100% { transform: scale(1); opacity: 0.7; }
          }
        }
      `}</style>
    </div>
  )
}

/* ─── #6 Layer Shift ─── */
export function LayerShift() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative w-10 h-10 loading-anim-area">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="absolute rounded-md border border-border bg-background"
            style={{
              width: `${28 - i * 4}px`,
              height: `${28 - i * 4}px`,
              left: `${6 + i * 2}px`,
              top: `${6 + i * 2}px`,
              animation: `layerShift 2s ease-in-out ${i * 0.3}s infinite`,
              boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
            }}
          />
        ))}
      </div>
      <span className="text-sm text-muted-foreground">Loading</span>
      <style>{`
        @keyframes layerShift {
          0%, 100% { transform: translate(0, 0) rotate(0deg); opacity: 0.5; }
          25% { transform: translate(-3px, -3px) rotate(-2deg); opacity: 0.8; }
          50% { transform: translate(0, -4px) rotate(0deg); opacity: 1; }
          75% { transform: translate(3px, -3px) rotate(2deg); opacity: 0.8; }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes layerShift {
            0%, 100% { transform: none; opacity: 0.8; }
          }
        }
      `}</style>
    </div>
  )
}

/* ─── #7 Progress Beam ─── */
export function ProgressBeam() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="w-32 h-1 bg-border rounded-full overflow-hidden loading-anim-area">
        <div
          className="h-full bg-primary rounded-full"
          style={{
            animation: 'progressBeam 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite',
          }}
        />
      </div>
      <span className="text-sm text-muted-foreground">Loading</span>
      <style>{`
        @keyframes progressBeam {
          0% { width: 0%; margin-left: 0%; }
          50% { width: 60%; margin-left: 20%; }
          100% { width: 0%; margin-left: 100%; }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes progressBeam {
            0%, 100% { width: 40%; margin-left: 30%; }
          }
        }
      `}</style>
    </div>
  )
}

/* ─── #8 Skeleton Board ─── */
export function SkeletonBoard() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex gap-2 loading-anim-area">
        {[0, 1, 2].map((col) => (
          <div key={col} className="flex flex-col gap-1.5 w-16">
            <div
              className="h-2 rounded-full bg-border"
              style={{ animation: `shimmer 1.8s ease-in-out ${col * 0.2}s infinite` }}
            />
            {[0, 1].map((row) => (
              <div
                key={row}
                className="h-6 rounded bg-muted"
                style={{
                  animation: `shimmer 1.8s ease-in-out ${(col * 2 + row) * 0.15}s infinite`,
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <span className="text-sm text-muted-foreground">Loading</span>
      <style>{`
        @keyframes shimmer {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes shimmer {
            0%, 100% { opacity: 0.7; }
          }
        }
      `}</style>
    </div>
  )
}

/* ─── #9 Glyph Rotate ─── */
export function GlyphRotate() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative w-10 h-10 loading-anim-area">
        <svg viewBox="0 0 40 40" className="w-10 h-10">
          <circle
            cx="20" cy="20" r="16"
            fill="none"
            stroke="var(--border)"
            strokeWidth="2"
          />
          <circle
            cx="20" cy="20" r="16"
            fill="none"
            stroke="var(--primary)"
            strokeWidth="2"
            strokeDasharray="25 75"
            strokeLinecap="round"
            style={{ animation: 'glyphRotate 1.2s linear infinite' }}
            transform="rotate(-90 20 20)"
          />
          <path
            d="M20 10L14 16L20 22L26 16Z"
            fill="var(--primary)"
            opacity="0.8"
            style={{ animation: 'glyphFade 1.2s ease-in-out infinite' }}
          />
        </svg>
      </div>
      <span className="text-sm text-muted-foreground">Loading</span>
      <style>{`
        @keyframes glyphRotate {
          to { stroke-dashoffset: -100; }
        }
        @keyframes glyphFade {
          0%, 100% { opacity: 0.4; transform: scale(0.9); }
          50% { opacity: 0.9; transform: scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes glyphRotate {
            to { stroke-dashoffset: 0; }
          }
          @keyframes glyphFade {
            0%, 100% { opacity: 0.8; transform: scale(1); }
          }
        }
      `}</style>
    </div>
  )
}

/* ─── #10 Charcoal Breathe ─── */
export function CharcoalBreathe({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const sizeClasses = size === 'lg'
    ? { container: 'w-20 h-20', img: 'w-16 h-16' }
    : { container: 'w-12 h-12', img: 'w-10 h-10' }

  return (
    <div className="flex flex-col items-center">
      <div className={`flex items-center justify-center ${sizeClasses.container} loading-anim-area`}>
        <img
          src={logoUrl}
          alt="Agent Tower"
          className={`${sizeClasses.img} object-contain rounded-xl`}
          style={{
            animation: 'charcoalBreathe 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
          }}
        />
      </div>
      <style>{`
        @keyframes charcoalBreathe {
          0%, 100% { transform: scale(1); opacity: 0.85; }
          50% { transform: scale(1.08); opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes charcoalBreathe {
            0%, 100% { transform: scale(1); opacity: 1; }
          }
        }
      `}</style>
    </div>
  )
}

export { REDUCED_MOTION_GLOBAL }

export const LOADING_ANIMATIONS = [
  {
    id: 'tower-pulse',
    name: 'Tower Pulse',
    description: 'Agent Tower 品牌图标配合脉冲光点，传达「系统就绪中」的品牌感。',
    component: TowerPulse,
  },
  {
    id: 'stack-rise',
    name: 'Stack Rise',
    description: '五根柱状条交错升降，暗喻任务编排队列，节奏感强。',
    component: StackRise,
  },
  {
    id: 'orbit-ring',
    name: 'Orbit Ring',
    description: '双层同心圆环反向旋转，精密工具质感，不浮夸。',
    component: OrbitRing,
  },
  {
    id: 'terminal-cursor',
    name: 'Terminal Cursor',
    description: '终端风格光标闪烁，与 Agent Tower 终端协作场景直接呼应。',
    component: TerminalCursor,
  },
  {
    id: 'dot-wave',
    name: 'Dot Wave',
    description: '三点波浪脉动，极简克制，适合工具型产品的默认加载。',
    component: DotWave,
  },
  {
    id: 'layer-shift',
    name: 'Layer Shift',
    description: '三层卡片微幅浮动，模拟看板层叠翻页，呼应任务管理语境。',
    component: LayerShift,
  },
  {
    id: 'progress-beam',
    name: 'Progress Beam',
    description: '水平光束往复滑过进度条，线性进度隐喻，不阻断视线。',
    component: ProgressBeam,
  },
  {
    id: 'skeleton-board',
    name: 'Skeleton Board',
    description: '三列骨架屏微闪，预示看板布局，减少布局跳变。',
    component: SkeletonBoard,
  },
  {
    id: 'glyph-rotate',
    name: 'Glyph Rotate',
    description: '圆环进度弧 + 中心菱形符号呼吸，兼具进度指示与品牌印记。',
    component: GlyphRotate,
  },
  {
    id: 'charcoal-breathe',
    name: 'Charcoal Breathe',
    description: 'Charcoal 圆角色块呼吸缩放，内嵌 Tower 图标，品牌存在感最强。',
    component: CharcoalBreathe,
  },
] as const
