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
    <div className="mx-6 mt-3 px-4 py-3 rounded-lg border border-amber-200 bg-amber-50 flex items-center gap-3">
      <AlertTriangle size={18} className="text-amber-600 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-amber-900">
          {t('{opLabel} 冲突 — {count} 个文件', { opLabel, count: gitStatus.conflictedFiles.length })}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          size="sm"
          onClick={() => abortOperation.mutate(workspaceId)}
          disabled={abortOperation.isPending}
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
