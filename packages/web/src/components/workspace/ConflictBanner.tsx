import type { GitOperationStatus } from '@agent-tower/shared'
import { useAbortOperation } from '@/hooks/use-workspaces'
import { Badge, Button, Notice } from '@/design-system'
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
    <Notice
      tone="warning"
      className="mx-6 mt-3 items-center"
      title={(
        <span className="flex items-center gap-2">
          {opLabel} {t('冲突')}
          <Badge tone="warning" className="tabular-nums">
            {gitStatus.conflictedFiles.length} {t('个文件')}
          </Badge>
        </span>
      )}
      action={(
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" onClick={() => abortOperation.mutate(workspaceId)} loading={abortOperation.isPending}>
            {t('中止操作')}
          </Button>
          <Button variant="primary" onClick={onResolve}>
            {t('解决冲突')}
          </Button>
        </div>
      )}
    />
  )
}
