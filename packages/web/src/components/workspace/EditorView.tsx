import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import { Loader2, X, PanelLeftOpen, ZoomIn, ZoomOut, Maximize } from 'lucide-react'
import { TransformWrapper, TransformComponent, useControls, useTransformComponent } from 'react-zoom-pan-pinch'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { FileTree } from './FileTree'
import { useFileContent, useSaveFile } from '@/hooks/use-files'
import { isTunnelAccess, getTunnelToken } from '@/lib/tunnel-token'

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif',
])

function isImageFile(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext ? IMAGE_EXTENSIONS.has(ext) : false
}

type OpenTab = {
  path: string // relative, e.g. "src/auth/Login.tsx"
  name: string
  language: string
  content: string
  savedContent: string
  isDirty: boolean
  loaded: boolean
  isImage: boolean
}

function buildImageUrl(workingDir: string, filePath: string) {
  const base = import.meta.env.VITE_API_URL || '/api'
  const params = new URLSearchParams({ workingDir, path: filePath })
  if (isTunnelAccess()) {
    const token = getTunnelToken()
    if (token) params.set('token', token)
  }
  return `${base}/files/image?${params.toString()}`
}

const ZoomToolbar: React.FC<{ filePath: string }> = ({ filePath }) => {
  const { t } = useI18n()
  const { zoomIn, zoomOut, centerView } = useControls()
  const scale = useTransformComponent((ctx) => ctx.state.scale)
  const pct = Math.round(scale * 100)

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-neutral-200 bg-neutral-50/80 shrink-0">
      <button
        type="button"
        onClick={() => zoomOut(0.5)}
        className="p-1 rounded hover:bg-neutral-200 text-neutral-500 hover:text-neutral-700 transition-colors"
        title={t('Zoom out')}
      >
        <ZoomOut size={14} />
      </button>
      <button
        type="button"
        onClick={() => centerView(1)}
        className="px-1.5 py-0.5 rounded hover:bg-neutral-200 text-[11px] text-neutral-600 tabular-nums min-w-[40px] text-center transition-colors"
        title={t('Reset zoom')}
      >
        {pct}%
      </button>
      <button
        type="button"
        onClick={() => zoomIn(0.5)}
        className="p-1 rounded hover:bg-neutral-200 text-neutral-500 hover:text-neutral-700 transition-colors"
        title={t('Zoom in')}
      >
        <ZoomIn size={14} />
      </button>
      <button
        type="button"
        onClick={() => centerView(1)}
        className="p-1 rounded hover:bg-neutral-200 text-neutral-500 hover:text-neutral-700 transition-colors ml-1"
        title={t('Fit to view')}
      >
        <Maximize size={13} />
      </button>
      <span className="ml-2 text-[11px] text-neutral-400 truncate">{filePath}</span>
    </div>
  )
}

const ImagePreview: React.FC<{ workingDir: string; filePath: string }> = ({
  workingDir,
  filePath,
}) => {
  const { t } = useI18n()
  const [error, setError] = useState(false)
  const src = buildImageUrl(workingDir, filePath)

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-neutral-500 text-sm">
        {t('Failed to load image.')}
      </div>
    )
  }

  return (
    <TransformWrapper
      initialScale={1}
      minScale={0.1}
      maxScale={10}
      centerOnInit
      doubleClick={{ mode: 'toggle' }}
    >
      <div className="h-full flex flex-col">
        <ZoomToolbar filePath={filePath} />
        <div className="flex-1 min-h-0 overflow-hidden bg-[repeating-conic-gradient(#f3f3f3_0%_25%,#fff_0%_50%)] bg-[length:16px_16px]">
          <TransformComponent
            wrapperStyle={{ width: '100%', height: '100%' }}
            contentStyle={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <img
              src={src}
              alt={filePath}
              className="max-w-full max-h-full object-contain rounded shadow-sm"
              draggable={false}
              onError={() => setError(true)}
            />
          </TransformComponent>
        </div>
      </div>
    </TransformWrapper>
  )
}

function basename(p: string) {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function inferMonacoLanguage(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'json':
      return 'json'
    case 'md':
    case 'mdx':
      return 'markdown'
    case 'css':
      return 'css'
    case 'scss':
      return 'scss'
    case 'html':
      return 'html'
    case 'yml':
    case 'yaml':
      return 'yaml'
    case 'sh':
      return 'shell'
    case 'py':
      return 'python'
    case 'go':
      return 'go'
    case 'rs':
      return 'rust'
    default:
      return 'plaintext'
  }
}

const FileTabButton: React.FC<{
  active: boolean
  name: string
  isDirty: boolean
  onClick: () => void
  onClose: (e: React.MouseEvent) => void
}> = ({ active, name, isDirty, onClick, onClose }) => {
  const { t } = useI18n()

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-center gap-2 px-3 py-2 rounded-t-md border-t border-x -mb-px min-w-[120px] max-w-[240px]',
        active
          ? 'bg-white border-neutral-200 text-neutral-900'
          : 'bg-neutral-100/60 border-transparent text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100'
      )}
    >
      <span className={cn('w-2 h-2 rounded-full', isDirty ? 'bg-amber-500' : 'bg-transparent')} />
      <span className="truncate flex-1 text-left text-xs">{name}</span>
      <span
        onClick={onClose}
        className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-neutral-200 rounded transition-all shrink-0"
        aria-label={t('Close tab')}
        title={t('Close')}
      >
        <X size={12} />
      </span>
    </button>
  )
}

export const EditorView: React.FC<{ workingDir?: string; className?: string }> = ({
  workingDir,
  className,
}) => {
  const { t } = useI18n()
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const saveMutation = useSaveFile()

  // File tree width & collapse state
  const [treeWidth, setTreeWidth] = useState(280)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const treeWidthBeforeCollapse = useRef(280)

  const toggleCollapse = useCallback(() => {
    setTreeCollapsed((prev) => {
      if (!prev) treeWidthBeforeCollapse.current = treeWidth
      else setTreeWidth(treeWidthBeforeCollapse.current)
      return !prev
    })
  }, [treeWidth])

  // Drag-to-resize logic
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    const startX = e.clientX
    const startWidth = treeWidth

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX
      const next = Math.min(480, Math.max(160, startWidth + delta))
      setTreeWidth(next)
    }
    const onMouseUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [treeWidth])

  // Reset when switching workspaces
  useEffect(() => {
    setTabs([])
    setActivePath(null)
  }, [workingDir])

  const activeTab = useMemo(
    () => tabs.find((t) => t.path === activePath) || null,
    [tabs, activePath]
  )

  const { data, isFetching, isError, error } = useFileContent(
    workingDir,
    activeTab?.isImage ? null : activePath
  )

  // Load content into active tab (only when not dirty and not loaded yet)
  useEffect(() => {
    if (!activePath || !data) return
    setTabs((prev) =>
      prev.map((t) => {
        if (t.path !== activePath) return t
        if (t.isDirty) return t
        if (t.loaded) return t
        return {
          ...t,
          language: data.language || t.language,
          content: data.content,
          savedContent: data.content,
          isDirty: false,
          loaded: true,
        }
      })
    )
  }, [activePath, data])

  const openFile = useCallback((filePath: string) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.path === filePath)
      if (existing) return prev
      const image = isImageFile(filePath)
      return [
        ...prev,
        {
          path: filePath,
          name: basename(filePath),
          language: inferMonacoLanguage(filePath),
          content: '',
          savedContent: '',
          isDirty: false,
          loaded: image, // images don't need content loading
          isImage: image,
        },
      ]
    })
    setActivePath(filePath)
  }, [])

  const closeTab = useCallback((filePath: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== filePath)
      setActivePath((prevActive) => {
        if (prevActive !== filePath) return prevActive
        return next.length ? next[next.length - 1]!.path : null
      })
      return next
    })
  }, [])

  const updateActiveContent = useCallback((nextContent: string) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.path !== activePath) return t
        const isDirty = nextContent !== t.savedContent
        return { ...t, content: nextContent, isDirty }
      })
    )
  }, [activePath])

  const doSave = useCallback(async () => {
    if (!workingDir || !activeTab) return
    await saveMutation.mutateAsync({
      workingDir,
      path: activeTab.path,
      content: activeTab.content,
    })
    setTabs((prev) =>
      prev.map((t) =>
        t.path === activeTab.path
          ? { ...t, savedContent: t.content, isDirty: false, loaded: true }
          : t
      )
    )
  }, [workingDir, activeTab, saveMutation])

  // Monaco keybinding (Cmd/Ctrl+S)
  const saveRef = useRef<() => void>(() => {})
  useEffect(() => {
    saveRef.current = () => {
      doSave().catch(() => {})
    }
  }, [doSave])

  // Global keybinding (when focus is outside Monaco)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() !== 's') return
      e.preventDefault()
      saveRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const monacoOnMount = useCallback((editor: any, monaco: any) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveRef.current()
    })
  }, [])

  return (
    <div className={cn('flex h-full overflow-hidden bg-white', className)} style={isDragging ? { userSelect: 'none', cursor: 'col-resize' } : undefined}>
      {/* Left: file tree */}
      <div
        className="border-r border-neutral-200 bg-white shrink-0 overflow-hidden relative"
        style={{ width: treeCollapsed ? 36 : treeWidth, transition: isDragging ? 'none' : 'width 0.15s ease' }}
      >
        {treeCollapsed ? (
          <div className="h-full flex items-start pt-2 justify-center">
            <button
              type="button"
              onClick={toggleCollapse}
              className="p-1.5 rounded hover:bg-neutral-100 text-neutral-500 hover:text-neutral-700 transition-colors"
              title={t('Expand file tree')}
            >
              <PanelLeftOpen size={16} />
            </button>
          </div>
        ) : (
          <>
            <FileTree
              key={workingDir || 'no-working-dir'}
              workingDir={workingDir}
              onFileSelect={openFile}
              selectedFilePath={activeTab?.path || null}
              onCollapse={toggleCollapse}
            />
          </>
        )}
      </div>

      {/* Drag handle */}
      {!treeCollapsed && (
        <div
          onMouseDown={onDragStart}
          className={cn(
            'w-1 shrink-0 cursor-col-resize transition-colors',
            isDragging ? 'bg-blue-400' : 'bg-transparent hover:bg-blue-300'
          )}
        />
      )}

      {/* Right: tabs + editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Tab bar */}
        <div className="flex items-center gap-1 px-2 pt-2 border-b border-neutral-200 bg-neutral-100/80 overflow-x-auto shrink-0">
          {tabs.length === 0 ? (
            <div className="px-2 pb-2 text-xs text-neutral-500">{t('No open files')}</div>
          ) : (
            tabs.map((t) => (
              <FileTabButton
                key={t.path}
                active={t.path === activePath}
                name={t.name}
                isDirty={t.isDirty}
                onClick={() => setActivePath(t.path)}
                onClose={(e) => {
                  e.stopPropagation()
                  closeTab(t.path)
                }}
              />
            ))
          )}

          <div className="ml-auto flex items-center gap-2 pb-2 pr-1">
            {saveMutation.isPending && (
              <span className="flex items-center gap-2 text-xs text-neutral-500">
                <Loader2 size={14} className="animate-spin" />
                {t('Saving')}
              </span>
            )}
            {activeTab?.isDirty && !saveMutation.isPending && (
              <span className="text-[11px] text-amber-600">{t('Unsaved')}</span>
            )}
          </div>
        </div>

        {/* Editor area */}
        <div className="flex-1 min-h-0 relative">
          {!workingDir ? (
            <div className="h-full flex items-center justify-center text-neutral-500 text-sm">
              {t('No workspace selected.')}
            </div>
          ) : !activeTab ? (
            <div className="h-full flex items-center justify-center text-neutral-500 text-sm">
              {t('Select a file from the tree to open.')}
            </div>
          ) : activeTab.isImage ? (
            <ImagePreview workingDir={workingDir} filePath={activeTab.path} />
          ) : (
            <>
              <Editor
                path={activeTab.path}
                value={activeTab.content}
                language={activeTab.language}
                theme="vs-light"
                height="100%"
                onChange={(v) => updateActiveContent(v ?? '')}
                onMount={monacoOnMount}
                options={{
                  fontSize: 13,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  wordWrap: 'off',
                  automaticLayout: true,
                }}
              />

              {isFetching && !activeTab.loaded && (
                <div className="absolute inset-0 bg-white/60 flex items-center justify-center">
                  <div className="flex items-center gap-2 text-xs text-neutral-600">
                    <Loader2 size={14} className="animate-spin" />
                    {t('Loading file...')}
                  </div>
                </div>
              )}

              {isError && (
                <div className="absolute bottom-2 left-2 right-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
                  {t('Failed to load file')}{error instanceof Error ? `: ${error.message}` : ''}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
