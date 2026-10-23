import { useId, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useProjectWorkspaceBranches } from '@/hooks/use-workspaces'
import { useUpdateProject } from '@/hooks/use-projects'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { BranchSelect } from './BranchSelect'

export function ProjectBaseBranchSettings({ projectId }: { projectId: string }) {
  const { t } = useI18n()
  const query = useProjectWorkspaceBranches(projectId)

  return (
    <div className="py-5 first:pt-0 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-medium text-foreground">{t('Default base branch')}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('New tasks default to this branch. Saved task and workspace bases remain unchanged.')}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching} aria-label={t('Refresh')}>
          <RefreshCw size={13} className={query.isFetching ? 'animate-spin motion-reduce:[animation-duration:2.4s]' : ''} />
        </Button>
      </div>
      {query.isPending ? <p className="text-xs text-muted-foreground">{t('Loading...')}</p> : query.isError ? (
        <p role="alert" className="text-xs text-destructive-ink">{t('Could not load branches. Refresh to try again.')}</p>
      ) : query.data && (
        <DefaultBaseBranchEditor
          key={`${projectId}:${query.data.mainBranch}`}
          projectId={projectId}
          mainBranch={query.data.mainBranch}
          branches={query.data.branches}
          isRefreshing={query.isFetching}
          onRefresh={() => void query.refetch()}
        />
      )}
    </div>
  )
}

function DefaultBaseBranchEditor({ projectId, mainBranch, branches, isRefreshing, onRefresh }: {
  projectId: string
  mainBranch: string
  branches: string[]
  isRefreshing: boolean
  onRefresh: () => void
}) {
  const { t } = useI18n()
  const selectId = useId()
  const [branch, setBranch] = useState(mainBranch)
  const update = useUpdateProject()

  const save = async () => {
    try {
      await update.mutateAsync({ id: projectId, mainBranch: branch })
      toast.success(t('Default base branch saved'))
    } catch { /* Mutation state displays the error below. */ }
  }

  return (
    <div className="space-y-3">
      <label htmlFor={selectId} className="block text-xs font-medium">{t('Default base branch')}</label>
      <BranchSelect id={selectId} label={t('Default base branch')} value={branch} branches={branches}
        disabled={update.isPending} isRefreshing={isRefreshing} onOpen={onRefresh} onChange={(value) => {
          setBranch(value)
          update.reset()
        }} />
      {update.isError && <p role="alert" className="text-xs text-destructive-ink">{t('Could not save the default base branch. Refresh and choose an existing local branch.')}</p>}
      <Button size="sm" onClick={() => void save()} disabled={branch === mainBranch || !branches.includes(branch) || update.isPending || isRefreshing}>
        {update.isPending ? t('Saving') : t('Save default base branch')}
      </Button>
    </div>
  )
}
