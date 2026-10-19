import React, { useCallback, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  PanelLeftClose,
  RefreshCw,
} from 'lucide-react'
import { FileGlyph, IconButton } from '@/design-system'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { useFileTree, useRefreshFileTree } from '@/hooks/use-files'

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
    aria-current={active || undefined}
    className={cn(
      'w-full flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60',
      active ? 'bg-foreground/[0.06] font-medium text-foreground' : 'text-foreground/90 hover:bg-accent'
    )}
    style={{ paddingLeft: 8 + depth * 14 }}
  >
    <span className="shrink-0">{rightIcon}</span>
    <span className="shrink-0 text-muted-foreground">{leftIcon}</span>
    <span className="truncate">{label}</span>
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
      <div className="text-xs text-muted-foreground px-2 py-1" style={{ paddingLeft: 8 + depth * 14 }}>
        {t('Loading...')}
      </div>
    )
  }

  if (isError) {
    return (
      <div className="text-xs text-destructive-ink px-2 py-1" style={{ paddingLeft: 8 + depth * 14 }}>
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
                    <ChevronDown size={14} className="text-muted-foreground/70" />
                  ) : (
                    <ChevronRight size={14} className="text-muted-foreground/70" />
                  )
                }
                leftIcon={
                  isOpen ? (
                    <FolderOpen size={14} />
                  ) : (
                    <Folder size={14} />
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
        const isActive = selectedFilePath === fp
        return (
          <TreeRow
            key={fp}
            depth={depth}
            active={isActive}
            onClick={() => onFileSelect(fp)}
            rightIcon={<span className="inline-block w-[14px]" />}
            leftIcon={<FileGlyph name={item.name} />}
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
      <div className="px-3 py-2 border-b border-border bg-muted/40 flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">
            {t('Files')}
          </div>
          {workingDir ? (
            <div title={workingDir} className="truncate font-mono text-[11px] text-muted-foreground">{workingDir}</div>
          ) : (
            <div className="truncate text-xs text-muted-foreground">{t('No working directory')}</div>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {workingDir && (
            <IconButton size="xs" label={t('Refresh file tree')} onClick={refreshFileTree}>
              <RefreshCw />
            </IconButton>
          )}
          {onCollapse && (
            <IconButton size="xs" label={t('Collapse file tree')} onClick={onCollapse}>
              <PanelLeftClose />
            </IconButton>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto scrollbar-app-thin p-2">
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
          <div className="text-xs text-muted-foreground px-2 py-2">
            {t('No workspace selected.')}
          </div>
        )}
      </div>
    </div>
  )
}
