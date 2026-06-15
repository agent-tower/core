import { AlertTriangle } from 'lucide-react'
import type { GitOperationStatus } from '@agent-tower/shared'
import { useAbortOperation } from '@/hooks/use-workspaces'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'

interface ConflictBannerProps {
  workspaceId: string
  gitStatus: GitOperationStatus
  onResolve: () => void
}

export function ConflictBanner({ workspaceId, gitStatus, onResolve }: ConflictBannerProps) {
  const { t } = useI18n()
  const abortOperation = useAbortOperation()

  // 无冲突时不渲染
  if (gitStatus.operation === 'idle' || gitStatus.conflictedFiles.length === 0) {
    return null
  }

  const opLabel = gitStatus.operation === 'rebase' ? 'Rebase' : 'Merge'

  return (
    <div className="mx-6 mt-3 flex items-center gap-3 rounded-lg border border-warning/25 bg-warning/[0.06] px-4 py-2.5">
      <AlertTriangle size={15} className="text-warning shrink-0" />
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className="text-sm font-medium text-foreground">
          {opLabel} {t('冲突')}
        </span>
        <span className="inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-xs font-semibold text-warning tabular-nums">
          {gitStatus.conflictedFiles.length} {t('个文件')}
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => abortOperation.mutate(workspaceId)}
          disabled={abortOperation.isPending}
          className="text-muted-foreground hover:text-foreground"
        >
          {t('中止操作')}
        </Button>
        <Button size="sm" onClick={onResolve}>
          {t('解决冲突')}
        </Button>
      </div>
    </div>
  )
}
