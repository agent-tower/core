import React, { useState, useRef, useEffect } from 'react'
import { Zap, Play, ChevronDown } from 'lucide-react'
import type { QuickCommand } from '@agent-tower/shared'
import { useI18n } from '@/lib/i18n'

export interface QuickCommandsPopoverProps {
  commands: QuickCommand[]
  onSelect: (command: string) => void
}

export const QuickCommandsPopover: React.FC<QuickCommandsPopoverProps> = React.memo(
  function QuickCommandsPopover({ commands, onSelect }) {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const popoverRef = useRef<HTMLDivElement>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
      if (!open) return
      const handler = (e: MouseEvent) => {
        if (popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
            buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
          setOpen(false)
        }
      }
      document.addEventListener('mousedown', handler)
      return () => document.removeEventListener('mousedown', handler)
    }, [open])

    if (commands.length === 0) return null

    return (
      <>
        {/* 分隔线 */}
        <div className="w-px h-4 bg-[#444] mx-1 shrink-0" />

        <div className="relative">
          <button
            ref={buttonRef}
            onClick={() => setOpen(!open)}
            className={`flex items-center gap-1.5 px-2.5 py-1 mx-1 rounded text-[11px] font-medium transition-colors shrink-0 ${
              open
                ? 'bg-amber-500/20 text-amber-300'
                : 'bg-amber-500/10 text-amber-400/80 hover:bg-amber-500/20 hover:text-amber-300'
            }`}
          >
            <Zap size={12} />
            <span>{t('快捷命令')}</span>
            <ChevronDown size={10} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>

          {open && (
            <div
              ref={popoverRef}
              className="absolute right-0 top-full mt-1 w-72 bg-[#2d2d2d] border border-[#444] rounded-lg shadow-xl z-[100] overflow-hidden"
            >
              <div className="max-h-[240px] overflow-y-auto">
                {commands.map((cmd, i) => (
                  <button
                    key={i}
                    onClick={() => { onSelect(cmd.command); setOpen(false) }}
                    className="w-full flex items-start gap-2.5 px-3 py-2 hover:bg-[#383838] transition-colors text-left group"
                  >
                    <Play size={12} className="text-green-500 mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-medium text-neutral-200">{cmd.name}</div>
                      <div className="text-[11px] font-mono text-neutral-500 truncate">{cmd.command}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </>
    )
  }
)
