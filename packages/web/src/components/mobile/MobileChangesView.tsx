import { useState } from 'react'
import { GitGraph, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { useGitChanges, useGitDiff, type GitChangeEntry } from '@/hooks/use-git'

type DiffType = 'uncommitted' | 'committed'

const STATUS_COLOR: Record<string, string> = {
  M: 'text-amber-600 border-amber-200 bg-amber-50',
  A: 'text-emerald-600 border-emerald-200 bg-emerald-50',
  D: 'text-red-600 border-red-200 bg-red-50',
  R: 'text-blue-600 border-blue-200 bg-blue-50',
}

function basename(p: string) {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function dirname(p: string) {
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : ''
}

// ============ Inline Diff ============

function InlineDiff({ workingDir, filePath, type }: { workingDir: string; filePath: string; type: DiffType }) {
  const { t } = useI18n()
  const { data, isLoading, isError } = useGitDiff(workingDir, filePath, type)

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-neutral-400">
        <Loader2 size={14} className="animate-spin" />
        <span className="text-xs">{t('Loading diff...')}</span>
      </div>
    )
  }

  if (isError) return <div className="px-3 py-3 text-xs text-red-500">{t('Failed to load diff.')}</div>

  const diff = data?.diff || ''
  if (!diff.trim()) return <div className="px-3 py-3 text-xs text-neutral-400">{t('No diff content available.')}</div>

  const lines = diff.split('\n')

  return (
    <div className="overflow-x-auto bg-neutral-950 rounded-lg mx-3 mb-3 font-mono text-[11px] leading-5">
      {lines.map((line, i) => {
        let bgClass = ''
        let textClass = 'text-neutral-400'

        if (line.startsWith('+') && !line.startsWith('+++')) {
          bgClass = 'bg-emerald-950/40'
          textClass = 'text-emerald-400'
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          bgClass = 'bg-red-950/40'
          textClass = 'text-red-400'
        } else if (line.startsWith('@@')) {
          bgClass = 'bg-blue-950/30'
          textClass = 'text-blue-400'
        }

        return (
          <div key={i} className={cn('px-3 whitespace-pre', bgClass, textClass)}>
            {line}
          </div>
        )
      })}
    </div>
  )
}

// ============ File Item (expandable) ============

function ExpandableFileItem({ entry, type, workingDir }: { entry: GitChangeEntry; type: DiffType; workingDir: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const colorClass = STATUS_COLOR[entry.status] || STATUS_COLOR.M
  const dir = dirname(entry.path)

  return (
    <div>
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className={cn(
          'flex items-center gap-2.5 w-full px-4 py-3 text-left active:bg-neutral-50',
          isOpen && 'bg-neutral-50'
        )}
      >
        <span className={cn('w-5 h-5 flex items-center justify-center text-[10px] font-bold border rounded shrink-0', colorClass)}>
          {entry.status}
        </span>
        <div className="flex-1 min-w-0">
          <span className="text-sm text-neutral-900 truncate block">{basename(entry.path)}</span>
          {dir && <span className="text-[11px] text-neutral-400 truncate block">{dir}</span>}
        </div>
        <span className="text-neutral-400 shrink-0">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {isOpen && <InlineDiff workingDir={workingDir} filePath={entry.path} type={type} />}
    </div>
  )
}

// ============ Collapsible Group ============

function ChangeGroup({
  title,
  entries,
  type,
  workingDir,
  defaultOpen,
}: {
  title: string
  entries: GitChangeEntry[]
  type: DiffType
  workingDir: string
  defaultOpen: boolean
}) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(defaultOpen)

  if (entries.length === 0) return null

  return (
    <div>
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className="flex items-center gap-2 w-full px-4 py-2.5 active:bg-neutral-50"
      >
        <span className="text-neutral-400">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">{t(title)}</span>
        <span className="text-[10px] bg-neutral-100 px-1.5 py-0.5 rounded text-neutral-500">{entries.length}</span>
      </button>
      {isOpen && (
        <div className="divide-y divide-neutral-100">
          {entries.map(entry => (
            <ExpandableFileItem key={`${type}:${entry.path}`} entry={entry} type={type} workingDir={workingDir} />
          ))}
        </div>
      )}
    </div>
  )
}

// ============ Main Component ============

export function MobileChangesView({ workingDir }: { workingDir?: string }) {
  const { t } = useI18n()
  const { data, isLoading, isError } = useGitChanges(workingDir)

  if (!workingDir) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-400 text-sm">
        {t('No workspace selected.')}
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-400">
        <Loader2 size={16} className="animate-spin mr-2" />
        <span className="text-sm">{t('Loading changes...')}</span>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-500 text-sm">
        {t('Failed to load changes.')}
      </div>
    )
  }

  const uncommitted = data?.uncommitted || []
  const committed = data?.committed || []
  const total = uncommitted.length + committed.length

  if (total === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-neutral-400 py-16">
        <GitGraph size={28} className="mb-3" />
        <span className="text-sm">{t('No pending changes')}</span>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto overscroll-y-contain">
      <ChangeGroup title="Uncommitted" entries={uncommitted} type="uncommitted" workingDir={workingDir} defaultOpen={true} />
      <ChangeGroup title="Committed" entries={committed} type="committed" workingDir={workingDir} defaultOpen={false} />
    </div>
  )
}
