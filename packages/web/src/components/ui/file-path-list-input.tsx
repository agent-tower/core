import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Folder, File, FolderPlus, Plus } from 'lucide-react'
import { apiClient } from '@/lib/api-client'
import { useI18n } from '@/lib/i18n'

interface CompletionItem {
  name: string
  path: string
  type: 'file' | 'directory'
}

export interface FilePathListInputProps {
  value: string[]
  onChange: (paths: string[]) => void
  repoPath: string
  placeholder?: string
}

export function FilePathListInput({ value, onChange, repoPath, placeholder }: FilePathListInputProps) {
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const [completions, setCompletions] = useState<CompletionItem[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const fetchCompletions = useCallback(async (prefix: string) => {
    if (!repoPath || !prefix) {
      setCompletions([])
      setShowDropdown(false)
      return
    }
    try {
      const res = await apiClient.get<{ results: CompletionItem[] }>(
        '/filesystem/complete',
        { params: { basePath: repoPath, prefix } },
      )
      setCompletions(res.results)
      setShowDropdown(res.results.length > 0)
      setSelectedIndex(-1)
    } catch {
      setCompletions([])
      setShowDropdown(false)
    }
  }, [repoPath])

  // Debounced fetch on input change
  useEffect(() => {
    clearTimeout(debounceRef.current)
    if (!input) {
      setCompletions([])
      setShowDropdown(false)
      return
    }
    debounceRef.current = setTimeout(() => fetchCompletions(input), 200)
    return () => clearTimeout(debounceRef.current)
  }, [input, fetchCompletions])
  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const addPath = (p: string) => {
    const trimmed = p.trim()
    if (!trimmed || value.includes(trimmed)) return
    onChange([...value, trimmed])
    setInput('')
    setShowDropdown(false)
    inputRef.current?.focus()
  }

  const removePath = (index: number) => {
    onChange(value.filter((_, i) => i !== index))
  }

  const handleSelect = (item: CompletionItem) => {
    if (item.type === 'directory') {
      // 选择目录：填入输入框继续深入浏览
      setInput(item.path)
      inputRef.current?.focus()
    } else {
      // 选择文件：直接添加
      addPath(item.path)
    }
  }

  const handleAddDir = (item: CompletionItem, e: React.MouseEvent) => {
    e.stopPropagation()
    // 去掉末尾 / 后添加目录路径
    addPath(item.path.replace(/\/$/, ''))
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
    if (showDropdown && completions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, completions.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, -1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (selectedIndex >= 0) {
          handleSelect(completions[selectedIndex])
        } else {
          addPath(input)
        }
      } else if (e.key === 'Escape') {
        setShowDropdown(false)
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      addPath(input)
    }
  }

  return (
    <div>
      {/* 已添加的路径列表 */}
      {value.length > 0 && (
        <div className="border border-neutral-200 rounded-lg mb-2 divide-y divide-neutral-100">
          {value.map((p, i) => (
            <div key={p} className="flex items-center gap-2 px-3 py-1.5 group">
              {p.includes('.') && !p.endsWith('/')
                ? <File size={14} className="text-neutral-400 shrink-0" />
                : <Folder size={14} className="text-amber-500 shrink-0" />
              }
              <span className="text-sm font-mono text-neutral-700 truncate flex-1">{p}</span>
              <button
                onClick={() => removePath(i)}
                className="p-0.5 text-neutral-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 输入框 + 补全下拉 */}
      <div className="relative">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (input && completions.length > 0) setShowDropdown(true) }}
            placeholder={placeholder ?? t('输入文件路径...')}
            className="flex-1 px-3 py-2 border border-neutral-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-1 focus:ring-neutral-300"
          />
          <button
            onClick={() => addPath(input)}
            disabled={!input.trim()}
            className="flex items-center gap-1 px-3 py-2 text-sm bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Plus size={14} />
            <span>{t('添加')}</span>
          </button>
        </div>

        {/* 补全下拉 */}
        {showDropdown && (
          <div
            ref={dropdownRef}
            className="absolute z-50 left-0 right-0 mt-1 bg-white border border-neutral-200 rounded-lg shadow-lg max-h-[200px] overflow-y-auto"
          >
            {completions.map((item, i) => (
              <button
                key={item.path}
                onClick={() => handleSelect(item)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-neutral-50 transition-colors ${
                  i === selectedIndex ? 'bg-neutral-100' : ''
                }`}
              >
                {item.type === 'directory'
                  ? <Folder size={14} className="text-amber-500 shrink-0" />
                  : <File size={14} className="text-neutral-400 shrink-0" />
                }
                <span className="font-mono text-neutral-700 truncate flex-1">{item.path}</span>
                {item.type === 'directory' && (
                  <span
                    onClick={(e) => handleAddDir(item, e)}
                    className="p-0.5 text-neutral-300 hover:text-emerald-600 shrink-0"
                    title={t('添加此目录')}
                  >
                    <FolderPlus size={14} />
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
