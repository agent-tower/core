import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/hooks/query-keys'
import {
  invalidateAllGitRealtimeQueries,
  invalidateWorkspaceGitQueries,
} from '../hooks/useWorkspaceGitRealtimeSync'

describe('invalidateWorkspaceGitQueries', () => {
  it('invalidates scoped git queries for a workspace git change payload', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    })
    queryClient.setQueryData(queryKeys.git.changes('/tmp/workspace-1'), { uncommitted: [], committed: [] })
    queryClient.setQueryData(queryKeys.git.diff('/tmp/workspace-1', 'file.txt', 'uncommitted'), { diff: 'old' })
    queryClient.setQueryData(queryKeys.git.log('/tmp/workspace-1'), { commits: [] })
    queryClient.setQueryData(queryKeys.git.changes('/tmp/workspace-2'), { uncommitted: [], committed: [] })
    queryClient.setQueryData(queryKeys.workspaces.gitStatus('workspace-1'), { operation: 'idle' })
    queryClient.setQueryData(queryKeys.workspaces.diff('workspace-1'), { diff: 'old' })

    invalidateWorkspaceGitQueries(queryClient, {
      workspaceId: 'workspace-1',
      workingDir: '/tmp/workspace-1',
    })

    expect(queryClient.getQueryState(queryKeys.git.changes('/tmp/workspace-1'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.git.diff('/tmp/workspace-1', 'file.txt', 'uncommitted'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.git.log('/tmp/workspace-1'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.git.changes('/tmp/workspace-2'))?.isInvalidated).toBe(false)
    expect(queryClient.getQueryState(queryKeys.workspaces.gitStatus('workspace-1'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.workspaces.diff('workspace-1'))?.isInvalidated).toBe(true)
  })

  it('falls back to all git queries when the payload cannot be scoped', () => {
    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    invalidateWorkspaceGitQueries(queryClient, null)

    expect(invalidateSpy).toHaveBeenCalledTimes(3)
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.git.all })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['workspaces', 'gitStatus'] })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['workspaces', 'diff'] })
  })

  it('invalidates workspace git status and diff queries for reconnect fallback', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    })
    queryClient.setQueryData(queryKeys.git.changes('/tmp/workspace-1'), { uncommitted: [], committed: [] })
    queryClient.setQueryData(queryKeys.workspaces.gitStatus('workspace-1'), { operation: 'idle' })
    queryClient.setQueryData(queryKeys.workspaces.gitStatus('workspace-2'), { operation: 'idle' })
    queryClient.setQueryData(queryKeys.workspaces.diff('workspace-1'), { diff: 'old' })
    queryClient.setQueryData(queryKeys.workspaces.detail('workspace-1'), { id: 'workspace-1' })

    invalidateAllGitRealtimeQueries(queryClient)

    expect(queryClient.getQueryState(queryKeys.git.changes('/tmp/workspace-1'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.workspaces.gitStatus('workspace-1'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.workspaces.gitStatus('workspace-2'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.workspaces.diff('workspace-1'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.workspaces.detail('workspace-1'))?.isInvalidated).toBe(false)
  })
})
