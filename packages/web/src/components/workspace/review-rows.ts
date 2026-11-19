import type { GitChangeEntry, GitChangesResponse, GitCommitDiffResponse, GitDiffResponse } from '@/hooks/use-git'
import { queryKeys } from '@/hooks/query-keys'

export const AUTO_COLLAPSE_LINES = 400
export const SECTION_HEIGHT = 32
export const CARD_HEADER_HEIGHT = 34
export const ROW_GAP = 12
const LINE_HEIGHT = 20
const NOTICE_HEIGHT = 80
const CONTEXT_LINES = 12

export type DiffType = 'uncommitted' | 'committed'
export type CardSource = { kind: 'working'; diffType: DiffType } | { kind: 'commit'; hash: string }
export type CardRow = { kind: 'card'; key: string; entry: GitChangeEntry; source: CardSource }
type SectionRow = { kind: 'section'; key: string; section: DiffType; count: number }
export type ReviewRow = CardRow | SectionRow
export type CardState = { collapsed?: boolean; force?: boolean; expanded?: boolean }
export type DiffAnswer = GitDiffResponse | GitCommitDiffResponse

function cardKeyOf(source: CardSource, path: string) {
  return source.kind === 'working' ? `${source.diffType}:${path}` : `${source.hash}:${path}`
}

export function buildReviewRows(changes?: GitChangesResponse, commitHash?: string | null, files?: GitChangeEntry[]): ReviewRow[] {
  const rows: ReviewRow[] = []
  function addCards(source: CardSource, entries: GitChangeEntry[]) {
    for (const entry of entries) rows.push({ kind: 'card', key: cardKeyOf(source, entry.path), source, entry })
  }
  if (commitHash) {
    addCards({ kind: 'commit', hash: commitHash }, files ?? [])
  } else if (changes) {
    for (const section of ['uncommitted', 'committed'] as const) {
      const entries = changes[section]
      if (!entries.length) continue
      rows.push({ kind: 'section', key: `section:${section}`, section, count: entries.length })
      addCards({ kind: 'working', diffType: section }, entries)
    }
  }
  return rows
}

export function filterReviewRows(rows: ReviewRow[], filter: string): ReviewRow[] {
  const term = filter.trim().toLowerCase()
  if (!term) return rows
  const result: ReviewRow[] = []
  let section: SectionRow | undefined
  for (const row of rows) {
    if (row.kind === 'section') {
      section = { ...row, count: 0 }
    } else if (row.entry.path.toLowerCase().includes(term)) {
      if (section) {
        if (section.count === 0) result.push(section)
        section.count++
      }
      result.push(row)
    }
  }
  return result
}

export function diffQueryKey(workingDir: string, { source, entry }: CardRow, force = false) {
  return source.kind === 'working'
    ? queryKeys.gitDiffs.file(workingDir, source.diffType, entry.path, entry.token ?? '', force)
    : queryKeys.gitDiffs.commit(workingDir, source.hash, entry.path)
}

export function estimateDiffBody(entry: GitChangeEntry, expanded = false, answer?: DiffAnswer): number {
  if (answer) {
    if (!('diff' in answer) || !answer.diff.trim()) return NOTICE_HEIGHT
    const count = answer.diff.split('\n').length
    return expanded || count <= AUTO_COLLAPSE_LINES ? count * LINE_HEIGHT : AUTO_COLLAPSE_LINES * LINE_HEIGHT + 32
  }
  const changed = (entry.additions ?? 0) + (entry.deletions ?? 0)
  return changed ? Math.min(changed + CONTEXT_LINES, AUTO_COLLAPSE_LINES) * LINE_HEIGHT : NOTICE_HEIGHT
}

/** Measure the border box. The virtualizer adds the gap between rows. */
export function estimateReviewRow(row: ReviewRow, state?: CardState, answer?: DiffAnswer): number {
  if (row.kind === 'section') return SECTION_HEIGHT
  if (state?.collapsed) return CARD_HEADER_HEIGHT
  return CARD_HEADER_HEIGHT + 1 + estimateDiffBody(row.entry, state?.expanded, answer)
}

/** Only the measured virtual window is needed, including its preceding overscan card. */
export function currentReviewCard(rows: ReviewRow[], items: readonly { index: number; start: number }[], top: number): CardRow | undefined {
  let current: CardRow | undefined
  for (const item of items) {
    const row = rows[item.index]
    if (row?.kind !== 'card') continue
    if (item.start > top + 8) return current ?? row
    current = row
  }
  return current
}
