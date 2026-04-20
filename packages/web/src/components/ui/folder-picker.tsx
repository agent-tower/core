import { useState, useEffect, useCallback, useRef } from 'react'
import { Folder, FolderGit2, ChevronRight, Loader2, AlertCircle } from 'lucide-react'
import { apiClient } from '@/lib/api-client'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

// === API 响应类型 ===

interface DirEntry {
  name: string
  path: string
  isGitRepo: boolean
}

interface BrowseResponse {
  current: string
  parent: string
  sep: string
  dirs: DirEntry[]
  drives?: string[]
}

interface ValidateResponse {
  valid: boolean
  path: string
  error?: string
}

// === Props ===

export interface FolderPickerProps {
  /** 当前选中的路径 */
  value: string
  /** 路径变化回调 */
  onChange: (path: string) => void
  /** 占位文字 */
  placeholder?: string
}

export function FolderPicker({ value, onChange, placeholder }: FolderPickerProps) {
  const { t } = useI18n()
  // 浏览器当前目录
  const [currentPath, setCurrentPath] = useState('')
  const [dirs, setDirs] = useState<DirEntry[]>([])
  const [parentPath, setParentPath] = useState('')
  const [pathSep, setPathSep] = useState('/')
  const [drives, setDrives] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 手动输入的路径
  const [inputValue, setInputValue] = useState(value)

  // 验证状态
  const [validationError, setValidationError] = useState<string | null>(null)
  const [isValidating, setIsValidating] = useState(false)

  // 初始加载标记
  const initialLoadDone = useRef(false)

  // 同步外部 value 到 inputValue
  useEffect(() => {
    setInputValue(value)
  }, [value])

  // === 浏览目录 ===
  const browsePath = useCallback(async (dirPath?: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const params: Record<string, string> = {}
      if (dirPath) params.path = dirPath
      const res = await apiClient.get<BrowseResponse>('/filesystem/browse', { params })
      setCurrentPath(res.current)
      setParentPath(res.parent)
      setPathSep(res.sep || '/')
      setDirs(res.dirs)
      if (res.drives) setDrives(res.drives)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse directory')
    } finally {
      setIsLoading(false)
    }
  }, [])

  // 初始加载 — 使用 home 目录
  useEffect(() => {
    if (!initialLoadDone.current) {
      initialLoadDone.current = true
      browsePath()
    }
  }, [browsePath])

  // === 验证并选中目录 ===
  const selectDirectory = useCallback(async (dirPath: string) => {
    setIsValidating(true)
    setValidationError(null)
    try {
      const res = await apiClient.get<ValidateResponse>('/filesystem/validate', {
        params: { path: dirPath },
      })
      if (res.valid) {
        onChange(dirPath)
        setValidationError(null)
      } else {
        setValidationError(res.error ?? 'Not a Git repository')
      }
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : 'Validation failed')
    } finally {
      setIsValidating(false)
    }
  }, [onChange])

  // === 点击目录条目 ===
  const handleDirClick = useCallback((entry: DirEntry) => {
    if (entry.isGitRepo) {
      // Git 仓库 → 选中
      selectDirectory(entry.path)
      // 同时也进入该目录方便用户查看子目录
      browsePath(entry.path)
    } else {
      // 非 Git 仓库 → 进入子目录
      browsePath(entry.path)
      setValidationError(null)
    }
  }, [selectDirectory, browsePath])

  // === 面包屑导航 ===
  const isWindows = pathSep === '\\'
  const breadcrumbSegments = currentPath
    ? currentPath.split(/[\\/]/).filter(Boolean)
    : []

  const handleBreadcrumbClick = useCallback((index: number) => {
    const segments = breadcrumbSegments.slice(0, index + 1)
    let targetPath: string
    if (isWindows) {
      targetPath = segments.join('\\')
      if (segments.length === 1 && /^[A-Za-z]:$/.test(segments[0])) {
        targetPath += '\\'
      }
    } else {
      targetPath = '/' + segments.join('/')
    }
    browsePath(targetPath)
    setValidationError(null)
  }, [breadcrumbSegments, browsePath, isWindows])

  // === 手动输入路径后按回车 ===
  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      e.preventDefault()
      const trimmed = inputValue.trim()
      if (trimmed) {
        // 跳转到该目录浏览
        browsePath(trimmed)
        // 同时尝试验证
        selectDirectory(trimmed)
      }
    }
  }, [inputValue, browsePath, selectDirectory])

  return (
    <div className="space-y-2">
      {/* 手动输入框 */}
      <div className="relative">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={placeholder ?? 'e.g., /Users/me/projects/my-repo'}
          className={cn(
            'w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none transition-colors pr-8',
            value
              ? 'border-emerald-300 bg-emerald-50/50 focus:border-emerald-400'
              : 'border-neutral-200 focus:border-neutral-400',
          )}
        />
        {value && (
          <FolderGit2
            size={14}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-500"
          />
        )}
      </div>

      {/* 提示文字 */}
      <p className="text-xs text-neutral-400">
        {t('Browse and select a Git repository, or type a path and press Enter')}
      </p>

      {/* Windows 盘符快捷切换 */}
      {drives.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {drives.map((drive) => (
            <button
              key={drive}
              onClick={() => { browsePath(drive); setValidationError(null) }}
              className={cn(
                'px-2 py-0.5 rounded text-xs font-mono transition-colors border',
                currentPath.toUpperCase().startsWith(drive.toUpperCase())
                  ? 'bg-neutral-900 text-white border-neutral-900'
                  : 'border-neutral-200 text-neutral-600 hover:bg-neutral-100',
              )}
            >
              {drive.replace('\\', '')}
            </button>
          ))}
        </div>
      )}

      {/* 面包屑导航 */}
      <div className="flex items-center gap-0.5 text-xs text-neutral-500 overflow-x-auto pb-1 scrollbar-none">
        {!isWindows && (
          <button
            onClick={() => browsePath('/')}
            className="hover:text-neutral-900 transition-colors flex-shrink-0 px-1 py-0.5 rounded hover:bg-neutral-100"
          >
            /
          </button>
        )}
        {breadcrumbSegments.map((segment, i) => (
          <span key={i} className="flex items-center gap-0.5 flex-shrink-0">
            {(isWindows ? i > 0 : true) && (
              <ChevronRight size={10} className="text-neutral-300" />
            )}
            <button
              onClick={() => handleBreadcrumbClick(i)}
              className={cn(
                'px-1 py-0.5 rounded transition-colors truncate max-w-[120px]',
                i === breadcrumbSegments.length - 1
                  ? 'font-medium text-neutral-900'
                  : 'hover:text-neutral-900 hover:bg-neutral-100',
              )}
            >
              {segment}
            </button>
          </span>
        ))}
      </div>

      {/* 目录列表 */}
      <div className="border border-neutral-200 rounded-lg overflow-hidden">
        <div className="max-h-[200px] overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-neutral-400">
              <Loader2 size={16} className="animate-spin mr-2" />
              <span className="text-xs">Loading...</span>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-8 text-red-500 gap-2">
              <AlertCircle size={14} />
              <span className="text-xs">{error}</span>
            </div>
          ) : dirs.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-neutral-400">
              <span className="text-xs">No subdirectories</span>
            </div>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {/* 返回上级按钮 */}
              {currentPath !== parentPath && (
                <li>
                  <button
                    onClick={() => browsePath(parentPath)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-neutral-50 transition-colors group"
                  >
                    <Folder size={14} className="text-neutral-400 flex-shrink-0" />
                    <span className="text-xs text-neutral-500 group-hover:text-neutral-700">..</span>
                  </button>
                </li>
              )}
              {dirs.map((entry) => (
                <li key={entry.path}>
                  <button
                    onClick={() => handleDirClick(entry)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors group',
                      entry.path === value
                        ? 'bg-emerald-50'
                        : 'hover:bg-neutral-50',
                    )}
                  >
                    {entry.isGitRepo ? (
                      <FolderGit2 size={14} className="text-emerald-500 flex-shrink-0" />
                    ) : (
                      <Folder size={14} className="text-neutral-400 flex-shrink-0" />
                    )}
                    <span
                      className={cn(
                        'text-xs truncate',
                        entry.path === value
                          ? 'font-medium text-emerald-700'
                          : 'text-neutral-700 group-hover:text-neutral-900',
                      )}
                    >
                      {entry.name}
                    </span>
                    {entry.isGitRepo && (
                      <span className="ml-auto flex-shrink-0 text-[10px] font-medium bg-emerald-100 text-emerald-600 px-1.5 py-0.5 rounded">
                        Git
                      </span>
                    )}
                    {!entry.isGitRepo && (
                      <ChevronRight
                        size={12}
                        className="ml-auto text-neutral-300 group-hover:text-neutral-400 flex-shrink-0"
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* 验证状态 */}
      {isValidating && (
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <Loader2 size={12} className="animate-spin" />
          <span>Validating...</span>
        </div>
      )}
      {validationError && (
        <div className="flex items-center gap-2 text-xs text-red-500">
          <AlertCircle size={12} />
          <span>{validationError}</span>
        </div>
      )}
    </div>
  )
}
