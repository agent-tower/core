import { useId, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { WorkspaceBaseBranchOption } from '@agent-tower/shared'
import { useProjectWorkspaceBranches, useUpdateWorkspaceBaseBranch } from '@/hooks/use-workspaces'
import { ApiError } from '@/lib/api-client'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'

const selectClass = 'w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-50'

const errorMessages: Record<string, string> = {
  INVALID_BASE_BRANCH: 'Choose an existing local branch different from the workspace branch.',
  BASE_BRANCH_UNRELATED: 'The selected branch has no shared commit history with this workspace.',
  WORKSPACE_BASE_BRANCH_BUSY: 'Wait for the Agent to finish or stop it before changing the base branch.',
  WORKSPACE_GIT_OPERATION_IN_PROGRESS: 'Finish or abort the current Git operation before changing the base branch.',
  WORKSPACE_BASE_BRANCH_CHANGED: 'The workspace changed. Refresh and select the base branch again.',
  INVALID_WORKSPACE_STATE: 'Only active workspaces can change base branch. Refresh the list.',
  WORKSPACE_BASE_BRANCH_MANAGED: 'TeamRun member base branches are managed by their parent workspace.',
}

export function WorkspaceBranchSettings({ projectId }: { projectId: string }) {
  const { t } = useI18n()
  const workspaceSelectId = useId()
  const query = useProjectWorkspaceBranches(projectId)
  const [selectedId, setSelectedId] = useState('')
  const workspace = query.data?.workspaces.find((item) => item.id === selectedId)

  return (
    <div className="py-5 first:pt-0 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-medium text-foreground">{t('Workspace base branch')}</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {t('Choose the branch used for changes, updates and merges in an existing workspace.')}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching} aria-label={t('Refresh')}>
          <RefreshCw size={13} className={query.isFetching ? 'animate-spin' : ''} />
        </Button>
      </div>
      {query.isPending ? <p className="text-xs text-muted-foreground">{t('Loading...')}</p> : query.isError ? (
        <p role="alert" className="text-xs text-destructive">{t('Could not load workspace branches. Refresh to try again.')}</p>
      ) : query.data && query.data.workspaces.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('No active worktree workspaces to configure.')}</p>
      ) : query.data && (
        <>
          <label htmlFor={workspaceSelectId} className="block text-xs font-medium">{t('Workspace')}</label>
          <select id={workspaceSelectId} value={workspace?.id ?? ''} onChange={(event) => setSelectedId(event.target.value)} className={selectClass}>
            <option value="">{t('Select a workspace')}</option>
            {query.data.workspaces.map((item) => (
              <option key={item.id} value={item.id}>{item.taskTitle} · {item.branchName}</option>
            ))}
          </select>
          {workspace && (
            <WorkspaceBaseBranchEditor
              key={`${workspace.id}:${workspace.baseBranch}:${query.data.mainBranch}`}
              workspace={workspace}
              branches={query.data.branches}
              mainBranch={query.data.mainBranch}
            />
          )}
        </>
      )}
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        {t('Available for active task and TeamRun main workspaces. Member workspaces follow their parent workspace.')}
      </p>
    </div>
  )
}

function WorkspaceBaseBranchEditor({ workspace, branches, mainBranch }: {
  workspace: WorkspaceBaseBranchOption
  branches: string[]
  mainBranch: string
}) {
  const { t } = useI18n()
  const branchSelectId = useId()
  const currentBranch = workspace.baseBranch || mainBranch
  const [baseBranch, setBaseBranch] = useState(currentBranch)
  const update = useUpdateWorkspaceBaseBranch()
  const availableBranches = branches.filter((branch) => branch !== workspace.branchName)
  const canSave = baseBranch !== currentBranch && availableBranches.includes(baseBranch) && !update.isPending
  const errorCode = update.error instanceof ApiError ? String(update.error.details.code) : ''

  const save = async () => {
    try {
      await update.mutateAsync({ id: workspace.id, baseBranch, expectedBaseBranch: workspace.baseBranch })
      toast.success(t('Workspace base branch saved'))
    } catch { /* Mutation state displays the error below. */ }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground break-all">{workspace.branchName} → {currentBranch}</p>
      <label htmlFor={branchSelectId} className="block text-xs font-medium">{t('Base branch')}</label>
      <select id={branchSelectId} className={selectClass} value={baseBranch} disabled={update.isPending} onChange={(event) => {
        setBaseBranch(event.target.value)
        update.reset()
      }}>
        {!availableBranches.includes(baseBranch) && <option value={baseBranch} disabled>{baseBranch} ({t('Unavailable')})</option>}
        {availableBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
      </select>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        {t('Saving changes the comparison, update and merge target for this workspace. Existing commits and files stay in place; review the changes before merging.')}
      </p>
      {update.isError && <p role="alert" className="text-xs text-destructive">{t(errorMessages[errorCode] ?? 'Could not save the base branch. Refresh and try again.')}</p>}
      <Button size="sm" onClick={() => void save()} disabled={!canSave}>
        {update.isPending ? t('Saving') : t('Save base branch')}
      </Button>
    </div>
  )
}
