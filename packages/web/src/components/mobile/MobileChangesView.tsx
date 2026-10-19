import { useState } from 'react'
import { GitGraph, ChevronDown, ChevronRight } from 'lucide-react'
import { FileStatusBadge, Spinner } from '@/design-system'
import { DiffLine } from '@/components/workspace/DiffLine'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { useGitChanges, useGitDiff, type GitChangeEntry } from '@/hooks/use-git'

type DiffType = 'uncommitted' | 'committed'

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
      <div className="flex items-center gap-2 px-3 py-4 text-muted-foreground">
        <Spinner />
        <span className="text-xs">{t('Loading diff...')}</span>
      </div>
    )
  }

  if (isError) return <div className="px-3 py-3 text-xs text-destructive-ink">{t('Failed to load diff.')}</div>

  const diff = data?.diff || ''
  if (!diff.trim()) return <div className="px-3 py-3 text-xs text-muted-foreground">{t('No diff content available.')}</div>

  const lines = diff.split('\n')

  return (
    <div className="overflow-x-auto scrollbar-app-thin mx-3 mb-3 rounded-lg border border-border/60 bg-background py-1 font-mono text-xs leading-5">
      <div className="min-w-max">
        {lines.map((line, i) => <DiffLine key={i} line={line} lineNum={i + 1} />)}
      </div>
    </div>
  )
}

// ============ File Item (expandable) ============

function ExpandableFileItem({ entry, type, workingDir }: { entry: GitChangeEntry; type: DiffType; workingDir: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const dir = dirname(entry.path)

  return (
    <div>
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className={cn(
          'flex items-center gap-2.5 w-full px-4 py-3 text-left active:bg-accent',
          isOpen && 'bg-muted/50'
        )}
      >
        <FileStatusBadge status={entry.status} size="md" />
        <div className="flex-1 min-w-0">
          <span className="text-sm text-foreground truncate block">{basename(entry.path)}</span>
          {dir && <span className="text-[11px] text-muted-foreground truncate block">{dir}</span>}
        </div>
        <span className="text-muted-foreground shrink-0">
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
        className="flex items-center gap-2 w-full px-4 py-2.5 active:bg-accent"
      >
        <span className="text-muted-foreground">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t(title)}</span>
        <span className="text-[11px] tabular-nums bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{entries.length}</span>
      </button>
      {isOpen && (
        <div className="divide-y divide-border/60">
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
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        {t('No workspace selected.')}
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <Spinner size="md" className="mr-2" />
        <span className="text-sm">{t('Loading changes...')}</span>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex-1 flex items-center justify-center text-destructive-ink text-sm">
        {t('Failed to load changes.')}
      </div>
    )
  }

  const uncommitted = data?.uncommitted || []
  const committed = data?.committed || []
  const total = uncommitted.length + committed.length

  if (total === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground py-16">
        <GitGraph size={28} className="mb-3" />
        <span className="text-sm">{t('No pending changes')}</span>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto scrollbar-app-thin overscroll-y-contain">
      <ChangeGroup title="Uncommitted" entries={uncommitted} type="uncommitted" workingDir={workingDir} defaultOpen={true} />
      <ChangeGroup title="Committed" entries={committed} type="committed" workingDir={workingDir} defaultOpen={false} />
    </div>
  )
}
