import type { GitFileDiffResponse } from '@agent-tower/shared'
import { Button } from '@/design-system'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** A diff answer that has no text to show: a binary file, or a file above the size limit. */
export type FileDiffNoticeAnswer = Exclude<GitFileDiffResponse, { kind: 'text' }>

/** Byte size for the notices, in binary units like the server's limits (1 MiB shows as "1 MB"). */
function formatDiffSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unit]}`
}

/** "old → new"; a side that does not exist (an added or deleted file) is left out. */
function formatDiffSizes(oldSize: number | null, newSize: number | null): string {
  return [oldSize, newSize].filter((size): size is number => size !== null).map(formatDiffSize).join(' → ')
}

/**
 * What a diff card shows instead of a text diff. A file above the default limit offers
 * "Load anyway" (`onLoadAnyway`, which asks again with `force`); above the forced limit, or once
 * forced, there is no override.
 */
export function FileDiffNotice({
  answer,
  loading = false,
  onLoadAnyway,
  className,
}: {
  answer: FileDiffNoticeAnswer
  loading?: boolean
  onLoadAnyway?: () => void
  className?: string
}) {
  const { t } = useI18n()
  const sizes = formatDiffSizes(answer.oldSize, answer.newSize)
  const message = answer.kind === 'binary'
    ? t('Binary file, no diff shown.')
    : answer.canForce
      ? t('Diff not shown: the file is larger than {limit}.', { limit: formatDiffSize(answer.limit) })
      : t('Diff not shown: the file is too large.')
  const canLoad = answer.kind === 'too_large' && answer.canForce && onLoadAnyway

  return (
    <div
      data-testid="file-diff-notice"
      className={cn('flex flex-wrap items-center justify-center gap-x-3 gap-y-2 px-3 py-6 text-center text-xs text-muted-foreground', className)}
    >
      <span>{message}</span>
      {sizes && <span className="font-mono tabular-nums">{sizes}</span>}
      {canLoad && (
        <Button size="xs" variant="secondary" loading={loading} onClick={onLoadAnyway}>
          {t('Load anyway')}
        </Button>
      )}
    </div>
  )
}
