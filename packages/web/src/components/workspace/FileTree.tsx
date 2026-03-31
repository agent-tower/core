import React, { useCallback, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileJson2,
  FileText,
  Folder,
  FolderOpen,
  Image,
  PanelLeftClose,
  RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { useFileTree, useRefreshFileTree, type FileTreeItem } from '@/hooks/use-files'

export interface FileTreeProps {
  workingDir?: string
  className?: string
  selectedFilePath?: string | null
  onFileSelect: (filePath: string) => void
  onCollapse?: () => void
}

type DirPath = string // always starts with "/" (root is "/")

function joinDir(parent: DirPath, name: string): DirPath {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

function filePathFromDir(dir: DirPath, name: string) {
  return dir === '/' ? name : `${dir.slice(1)}/${name}`
}

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif',
])

function fileIcon(item: FileTreeItem) {
  if (item.type === 'directory') return null
  const ext = item.name.split('.').pop()?.toLowerCase()
  if (ext && IMAGE_EXTENSIONS.has(ext)) return Image
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return FileCode2
  if (ext === 'json') return FileJson2
  if (ext === 'md' || ext === 'mdx' || ext === 'txt') return FileText
  return File
}

const TreeRow: React.FC<{
  depth: number
  active?: boolean
  onClick?: () => void
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
  label: string
}> = ({ depth, active, onClick, leftIcon, rightIcon, label }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'w-full flex items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-100',
      active && 'bg-neutral-100 text-neutral-900'
    )}
    style={{ paddingLeft: 8 + depth * 14 }}
  >
    <span className="shrink-0">{rightIcon}</span>
    <span className="shrink-0 text-neutral-500">{leftIcon}</span>
    <span className="truncate text-neutral-700">{label}</span>
  </button>
)

const DirectoryNode: React.FC<{
  workingDir?: string
  path: DirPath
  depth: number
  expanded: Set<string>
  toggleDir: (dir: DirPath) => void
  onFileSelect: (filePath: string) => void
  selectedFilePath?: string | null
}> = ({
  workingDir,
  path,
  depth,
  expanded,
  toggleDir,
  onFileSelect,
  selectedFilePath,
}) => {
  const { t } = useI18n()
  const { data, isLoading, isError } = useFileTree(workingDir, path)

  const items = useMemo(() => data?.items ?? [], [data?.items])

  if (isLoading) {
    return (
      <div className="text-xs text-neutral-400 px-2 py-1" style={{ paddingLeft: 8 + depth * 14 }}>
        {t('Loading...')}
      </div>
    )
  }

  if (isError) {
    return (
      <div className="text-xs text-red-600 px-2 py-1" style={{ paddingLeft: 8 + depth * 14 }}>
        {t('Failed to load')}
      </div>
    )
  }

  return (
    <div className="space-y-0.5">
      {items.map((item) => {
        if (item.type === 'directory') {
          const childDir = joinDir(path, item.name)
          const isOpen = expanded.has(childDir)
          return (
            <div key={childDir}>
              <TreeRow
                depth={depth}
                onClick={() => toggleDir(childDir)}
                rightIcon={
                  isOpen ? (
                    <ChevronDown size={14} className="text-neutral-400" />
                  ) : (
                    <ChevronRight size={14} className="text-neutral-400" />
                  )
                }
                leftIcon={
                  isOpen ? (
                    <FolderOpen size={14} className="text-amber-500" />
                  ) : (
                    <Folder size={14} className="text-amber-500" />
                  )
                }
                label={item.name}
              />
              {isOpen && (
                <DirectoryNode
                  workingDir={workingDir}
                  path={childDir}
                  depth={depth + 1}
                  expanded={expanded}
                  toggleDir={toggleDir}
                  onFileSelect={onFileSelect}
                  selectedFilePath={selectedFilePath}
                />
              )}
            </div>
          )
        }

        const fp = filePathFromDir(path, item.name)
        const Icon = fileIcon(item)
        const isActive = selectedFilePath === fp
        const isImg = Icon === Image
        return (
          <TreeRow
            key={fp}
            depth={depth}
            active={isActive}
            onClick={() => onFileSelect(fp)}
            rightIcon={<span className="inline-block w-[14px]" />}
            leftIcon={Icon ? <Icon size={14} className={isImg ? 'text-emerald-600' : 'text-sky-600'} /> : null}
            label={item.name}
          />
        )
      })}
    </div>
  )
}

export const FileTree: React.FC<FileTreeProps> = ({
  workingDir,
  className,
  onFileSelect,
  selectedFilePath,
  onCollapse,
}) => {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const refreshFileTree = useRefreshFileTree(workingDir)

  const toggleDir = useCallback((dir: DirPath) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }, [])

  return (
    <div className={cn('h-full flex flex-col', className)}>
      <div className="px-3 py-2 border-b border-neutral-200 bg-neutral-50/80 flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">
            {t('Files')}
          </div>
          <div className="text-[11px] text-neutral-400 truncate">{workingDir || t('No working directory')}</div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {workingDir && (
            <button
              type="button"
              onClick={refreshFileTree}
              className="p-1 rounded hover:bg-neutral-200 text-neutral-400 hover:text-neutral-700 transition-colors"
              title={t('Refresh file tree')}
            >
              <RefreshCw size={13} />
            </button>
          )}
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="p-1 rounded hover:bg-neutral-200 text-neutral-400 hover:text-neutral-700 transition-colors"
              title={t('Collapse file tree')}
            >
              <PanelLeftClose size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-2">
        {workingDir ? (
          <DirectoryNode
            workingDir={workingDir}
            path="/"
            depth={0}
            expanded={expanded}
            toggleDir={toggleDir}
            onFileSelect={onFileSelect}
            selectedFilePath={selectedFilePath}
          />
        ) : (
          <div className="text-xs text-neutral-500 px-2 py-2">
            {t('No workspace selected.')}
          </div>
        )}
      </div>
    </div>
  )
}
