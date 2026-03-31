import React, { useState, useCallback } from 'react'
import { GitGraph, Loader2, FileCode2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { useGitChanges, useGitDiff, type GitChangeEntry } from '@/hooks/use-git'

type DiffType = 'uncommitted' | 'committed'

const STATUS_COLOR_MAP: Record<string, string> = {
  M: 'text-amber-600 border-amber-200 bg-amber-50',
  A: 'text-emerald-600 border-emerald-200 bg-emerald-50',
  D: 'text-red-600 border-red-200 bg-red-50',
  R: 'text-blue-600 border-blue-200 bg-blue-50',
}

const STATUS_LABEL_MAP: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
}

function basename(p: string) {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function dirname(p: string) {
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : ''
}

/** 单个文件条目 */
const FileItem: React.FC<{
  entry: GitChangeEntry
  selected: boolean
  onClick: () => void
}> = ({ entry, selected, onClick }) => {
  const { t } = useI18n()
  const colorClass = STATUS_COLOR_MAP[entry.status] || STATUS_COLOR_MAP.M
  const label = STATUS_LABEL_MAP[entry.status] || entry.status
  const dir = dirname(entry.path)

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer group w-full text-left',
        selected ? 'bg-blue-50' : 'hover:bg-neutral-50'
      )}
    >
      <span
        className={cn(
          'w-4 h-4 flex items-center justify-center text-[10px] font-bold border rounded-sm shrink-0',
          colorClass
        )}
        title={t(label)}
      >
        {entry.status}
      </span>
      <span className="text-xs text-neutral-900 truncate">
        {basename(entry.path)}
      </span>
      {dir && (
        <span className="text-[10px] text-neutral-400 truncate ml-auto shrink-0">
          {dir}
        </span>
      )}
    </button>
  )
}

/** 文件分组 */
const FileGroup: React.FC<{
  title: string
  entries: GitChangeEntry[]
  type: DiffType
  selectedKey: string | null
  onSelect: (path: string, type: DiffType) => void
}> = ({ title, entries, type, selectedKey, onSelect }) => {
  const { t } = useI18n()
  if (entries.length === 0) return null

  return (
    <div>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
          {t(title)}
        </span>
        <span className="text-[10px] text-neutral-400">{entries.length}</span>
      </div>
      <div className="space-y-0.5">
        {entries.map((entry) => {
          const key = `${type}:${entry.path}`
          return (
            <FileItem
              key={key}
              entry={entry}
              selected={selectedKey === key}
              onClick={() => onSelect(entry.path, type)}
            />
          )
        })}
      </div>
    </div>
  )
}

/** Diff 行渲染 */
const DiffLine: React.FC<{ line: string; lineNum: number }> = ({ line, lineNum }) => {
  let bgClass = ''
  let textClass = 'text-neutral-700'

  if (line.startsWith('+') && !line.startsWith('+++')) {
    bgClass = 'bg-emerald-50'
    textClass = 'text-emerald-800'
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    bgClass = 'bg-red-50'
    textClass = 'text-red-800'
  } else if (line.startsWith('@@')) {
    bgClass = 'bg-blue-50'
    textClass = 'text-blue-700'
  } else if (line.startsWith('diff ') || line.startsWith('index ')) {
    textClass = 'text-neutral-400'
  }

  return (
    <div className={cn('flex', bgClass)}>
      <span className="w-10 shrink-0 text-right pr-2 text-neutral-400 select-none border-r border-neutral-100">
        {lineNum}
      </span>
      <span className={cn('pl-2 whitespace-pre', textClass)}>{line}</span>
    </div>
  )
}

/** Diff 内容查看器 */
const DiffViewer: React.FC<{
  workingDir: string
  filePath: string
  type: DiffType
}> = ({ workingDir, filePath, type }) => {
  const { t } = useI18n()
  const { data, isLoading, isError } = useGitDiff(workingDir, filePath, type)

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500">
        <Loader2 size={16} className="animate-spin mr-2" />
        <span className="text-xs">{t('Loading diff...')}</span>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-500 text-xs">
        {t('Failed to load diff.')}
      </div>
    )
  }

  const diff = data?.diff || ''
  if (!diff.trim()) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-400 text-xs">
        {t('No diff content available.')}
      </div>
    )
  }

  const lines = diff.split('\n')

  return (
    <div className="flex-1 overflow-auto font-mono text-xs leading-5">
      {lines.map((line, i) => (
        <DiffLine key={i} line={line} lineNum={i + 1} />
      ))}
    </div>
  )
}

/** Changes Tab 主组件 */
export const ChangesView: React.FC<{ workingDir?: string }> = ({ workingDir }) => {
  const { t } = useI18n()
  const { data, isLoading, isError } = useGitChanges(workingDir)
  const [selected, setSelected] = useState<{ path: string; type: DiffType } | null>(null)
  const [treeWidth, setTreeWidth] = useState(260)
  const [isDragging, setIsDragging] = useState(false)

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

  const selectedKey = selected ? `${selected.type}:${selected.path}` : null

  const handleSelect = (filePath: string, type: DiffType) => {
    setSelected({ path: filePath, type })
  }

  if (!workingDir) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm bg-white h-full">
        {t('No workspace selected.')}
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500 bg-white h-full">
        <Loader2 size={16} className="animate-spin mr-2" />
        <span className="text-sm">{t('Loading changes...')}</span>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-500 text-sm bg-white h-full">
        {t('Failed to load changes.')}
      </div>
    )
  }

  const uncommitted = data?.uncommitted || []
  const committed = data?.committed || []
  const totalChanges = uncommitted.length + committed.length

  return (
    <div className="flex h-full bg-white" style={isDragging ? { userSelect: 'none', cursor: 'col-resize' } : undefined}>
      {/* Left: file list */}
      <div className="border-r border-neutral-200 flex flex-col shrink-0" style={{ width: treeWidth }}>
        {/* Header */}
        <div className="px-3 py-2.5 border-b border-neutral-100 shrink-0">
          <div className="flex items-center gap-2">
            <GitGraph size={14} className="text-neutral-500" />
            <span className="text-xs font-semibold text-neutral-900">{t('Changes')}</span>
            {totalChanges > 0 && (
              <span className="text-[10px] bg-neutral-100 px-1.5 py-0.5 rounded text-neutral-500">
                {totalChanges}
              </span>
            )}
          </div>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-auto p-1.5">
          {totalChanges === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-neutral-400">
              <GitGraph size={28} className="mb-2" />
              <span className="text-xs">{t('No pending changes')}</span>
            </div>
          ) : (
            <div className="space-y-2">
              <FileGroup
                title="Uncommitted"
                entries={uncommitted}
                type="uncommitted"
                selectedKey={selectedKey}
                onSelect={handleSelect}
              />
              <FileGroup
                title="Committed"
                entries={committed}
                type="committed"
                selectedKey={selectedKey}
                onSelect={handleSelect}
              />
            </div>
          )}
        </div>
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        className={cn(
          'w-1 shrink-0 cursor-col-resize transition-colors',
          isDragging ? 'bg-blue-400' : 'bg-transparent hover:bg-blue-300'
        )}
      />

      {/* Right: diff viewer */}
      <div className="flex-1 flex flex-col min-w-0">
        {selected ? (
          <>
            {/* Diff header */}
            <div className="px-3 py-2 border-b border-neutral-100 flex items-center gap-2 shrink-0">
              <FileCode2 size={14} className="text-neutral-500" />
              <span className="text-xs font-medium text-neutral-700 truncate">
                {selected.path}
              </span>
              <span className="text-[10px] text-neutral-400">
                ({t(selected.type === 'uncommitted' ? 'Uncommitted' : 'Committed')})
              </span>
            </div>
            <DiffViewer
              workingDir={workingDir}
              filePath={selected.path}
              type={selected.type}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-neutral-400">
            <div className="flex flex-col items-center gap-2">
              <FileCode2 size={28} />
              <span className="text-xs">{t('Select a file to view diff')}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
