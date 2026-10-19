import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Folder, FolderGit2, ChevronRight, Loader2, AlertCircle, Check } from 'lucide-react'
import { Badge, Button, Chip, Input } from '@/design-system'
import { apiClient } from '@/lib/api-client'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { getDirectoryClickAction } from './folder-picker-utils'

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
  reason?: string
  isGitRepo?: boolean
  isEmpty?: boolean
  error?: string
}

type ValidationMode = 'git' | 'directory'

// === Props ===

export interface FolderPickerProps {
  /** 当前选中的路径 */
  value: string
  /** 路径变化回调 */
  onChange: (path: string) => void
  /** 校验模式：git 要求 Git 仓库，directory 只选择目录并把校验交给外层流程 */
  validationMode?: ValidationMode
  /** 占位文字 */
  placeholder?: string
}

export function FolderPicker({ value, onChange, validationMode = 'git', placeholder }: FolderPickerProps) {
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
    setInputValue(dirPath)

    if (validationMode === 'directory') {
      onChange(dirPath)
      setValidationError(null)
      return
    }

    setIsValidating(true)
    setValidationError(null)
    try {
      const res = await apiClient.get<ValidateResponse>('/filesystem/validate', {
        params: { path: dirPath },
      })
      if (res.valid && res.isGitRepo !== false) {
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
  }, [onChange, validationMode])

  // === 点击目录条目 ===
  const handleDirClick = useCallback((entry: DirEntry) => {
    if (getDirectoryClickAction(entry, validationMode) === 'select-and-browse') {
      // Git 仓库 → 选中
      selectDirectory(entry.path)
      // 同时也进入该目录方便用户查看子目录
      browsePath(entry.path)
    } else {
      // 非 Git 仓库 → 进入子目录
      browsePath(entry.path)
      setValidationError(null)
    }
  }, [selectDirectory, browsePath, validationMode])

  // === 面包屑导航 ===
  const isWindows = pathSep === '\\'
  const breadcrumbSegments = useMemo(
    () => currentPath ? currentPath.split(/[\\/]/).filter(Boolean) : [],
    [currentPath],
  )

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
        <Input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={placeholder ?? 'e.g., /Users/me/projects/my-repo'}
          className="font-mono"
          suffix={value ? (
            validationMode === 'git'
              ? <FolderGit2 aria-hidden className="size-3.5 text-success" />
              : <Folder aria-hidden className="size-3.5 text-success" />
          ) : undefined}
        />
      </div>

      {/* 提示文字 */}
      <p className="text-xs text-muted-foreground">
        {validationMode === 'git'
          ? t('Browse and select a Git repository, or type a path and press Enter')
          : t('Browse and select a directory, or type a path and press Enter')}
      </p>

      {/* Windows 盘符快捷切换 */}
      {drives.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {drives.map((drive) => (
            <Chip
              key={drive}
              size="sm"
              selected={currentPath.toUpperCase().startsWith(drive.toUpperCase())}
              onClick={() => { browsePath(drive); setValidationError(null) }}
              className="font-mono"
            >
              {drive.replace('\\', '')}
            </Chip>
          ))}
        </div>
      )}

      {/* 面包屑导航 */}
      <div className="flex items-center gap-0.5 text-xs text-muted-foreground overflow-x-auto pb-1 scrollbar-none">
        {!isWindows && (
          <button
            type="button"
            onClick={() => browsePath('/')}
            className="hover:text-foreground transition-colors flex-shrink-0 px-1 py-0.5 rounded hover:bg-accent"
          >
            /
          </button>
        )}
        {breadcrumbSegments.map((segment, i) => (
          <span key={i} className="flex items-center gap-0.5 flex-shrink-0">
            {(isWindows ? i > 0 : true) && (
              <ChevronRight size={10} aria-hidden="true" className="text-muted-foreground/50" />
            )}
            <button
              type="button"
              onClick={() => handleBreadcrumbClick(i)}
              className={cn(
                'px-1 py-0.5 rounded transition-colors truncate max-w-[120px]',
                i === breadcrumbSegments.length - 1
                  ? 'font-medium text-foreground/90'
                  : 'hover:text-foreground hover:bg-accent',
              )}
            >
              {segment}
            </button>
          </span>
        ))}
      </div>

      {/* 目录列表 */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="max-h-[200px] overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 size={16} className="animate-spin motion-reduce:[animation-duration:2.4s] mr-2" />
              <span className="text-xs">Loading...</span>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-8 text-destructive-ink gap-2">
              <AlertCircle size={14} />
              <span className="text-xs">{error}</span>
            </div>
          ) : dirs.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-8 text-muted-foreground">
              <span className="text-xs">No subdirectories</span>
              {validationMode === 'directory' && currentPath && (
                <Button
                  size="sm"
                  variant={currentPath === value ? 'soft' : 'secondary'}
                  aria-pressed={currentPath === value}
                  onClick={() => selectDirectory(currentPath)}
                >
                  <Check />
                  <span>{t('Select Current')}</span>
                </Button>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {/* 返回上级按钮 */}
              {currentPath !== parentPath && (
                <li>
                  <button
                    type="button"
                    onClick={() => browsePath(parentPath)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-accent transition-colors group"
                  >
                    <Folder size={14} className="text-muted-foreground flex-shrink-0" />
                    <span className="text-xs text-muted-foreground group-hover:text-foreground">..</span>
                  </button>
                </li>
              )}
              {dirs.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => handleDirClick(entry)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors group',
                      // 选中：浅灰底 + 加粗 + 对勾，与菜单的选中态一致
                      entry.path === value ? 'bg-accent' : 'hover:bg-accent',
                    )}
                  >
                    {entry.isGitRepo ? (
                      <FolderGit2 size={14} className="text-foreground/70 flex-shrink-0" />
                    ) : (
                      <Folder size={14} className="text-muted-foreground flex-shrink-0" />
                    )}
                    <span
                      className={cn(
                        'text-xs truncate',
                        entry.path === value
                          ? 'font-medium text-foreground'
                          : 'text-foreground/80 group-hover:text-foreground',
                      )}
                    >
                      {entry.name}
                    </span>
                    {entry.isGitRepo && (
                      <Badge size="sm" shape="tag" className="ml-auto shrink-0">Git</Badge>
                    )}
                    {entry.isGitRepo && entry.path === value && (
                      <Check size={12} className="shrink-0 text-foreground" />
                    )}
                    {!entry.isGitRepo && validationMode !== 'directory' && (
                      <ChevronRight
                        size={12}
                        className="ml-auto text-muted-foreground/70 group-hover:text-muted-foreground flex-shrink-0"
                      />
                    )}
                    {!entry.isGitRepo && validationMode === 'directory' && (
                      <Check
                        size={12}
                        className={cn(
                          'ml-auto flex-shrink-0',
                          entry.path === value ? 'text-foreground' : 'text-muted-foreground/70 group-hover:text-muted-foreground',
                        )}
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
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin motion-reduce:[animation-duration:2.4s]" />
          <span>Validating...</span>
        </div>
      )}
      {validationError && (
        <div className="flex items-center gap-2 text-xs text-destructive-ink">
          <AlertCircle size={12} />
          <span>{validationError}</span>
        </div>
      )}
    </div>
  )
}
