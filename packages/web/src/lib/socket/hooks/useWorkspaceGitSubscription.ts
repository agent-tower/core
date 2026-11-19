import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getWorkspaceGitSubscriptions } from '../workspace-git-subscriptions'

/**
 * Keeps a workspace's git state live while the calling view is mounted: the server pushes the
 * changes list and git status into the query cache, the history reloads when HEAD moves and open
 * diffs reload on each new state. Called once per open task view (desktop or mobile), whichever
 * panel tab is selected. The subscription pauses while the browser tab is hidden.
 */
export function useWorkspaceGitSubscription(workspaceId: string | undefined, workingDir: string | undefined): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!workspaceId || !workingDir) return
    return getWorkspaceGitSubscriptions(queryClient).retain(workspaceId, workingDir)
  }, [queryClient, workspaceId, workingDir])
}
