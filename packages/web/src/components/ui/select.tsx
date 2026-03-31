import * as React from "react"
import { useState, useRef, useEffect, useCallback } from "react"
import { ChevronDown, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n"

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "Select...",
  disabled = false,
  className,
}: SelectProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const selectedOption = options.find(o => o.value === value)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  // ESC 关闭
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    },
    []
  )

  return (
    <div ref={containerRef} className={cn("relative", className)} onKeyDown={handleKeyDown}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(prev => !prev)}
        className={cn(
          "flex items-center justify-between w-full h-9 px-3 border rounded-lg text-sm transition-colors",
          "bg-white border-neutral-200 hover:border-neutral-300",
          "focus:outline-none focus:border-neutral-400",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          open && "border-neutral-400",
          !selectedOption && "text-neutral-400",
        )}
      >
        <span className="truncate">
          {selectedOption ? selectedOption.label : t(placeholder)}
        </span>
        <ChevronDown
          size={14}
          className={cn(
            "ml-2 shrink-0 text-neutral-400 transition-transform duration-150",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[160px] bg-white border border-neutral-200 rounded-lg shadow-lg shadow-neutral-200/50 py-1 max-h-[200px] overflow-y-auto">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-sm text-neutral-400">{t('No options')}</div>
          ) : (
            options.map(option => (
              <button
                key={option.value}
                type="button"
                disabled={option.disabled}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
                className={cn(
                  "flex items-center w-full px-3 py-1.5 text-sm text-left transition-colors",
                  "hover:bg-neutral-50",
                  option.value === value
                    ? "text-neutral-900 font-medium"
                    : "text-neutral-600",
                  option.disabled && "opacity-40 cursor-not-allowed",
                )}
              >
                <Check
                  size={14}
                  className={cn(
                    "mr-2 shrink-0",
                    option.value === value ? "opacity-100" : "opacity-0"
                  )}
                />
                <span className="truncate">{option.label}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
