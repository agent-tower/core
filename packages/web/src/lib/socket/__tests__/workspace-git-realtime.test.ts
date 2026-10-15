import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/hooks/query-keys'
import {
  invalidateAllGitRealtimeQueries,
  syncVisibleWorkspaceGitQueries,
} from '../hooks/useWorkspaceGitRealtimeSync'

describe('syncVisibleWorkspaceGitQueries', () => {
  it('refreshes saved workspace metadata and cached file diffs when the base branch changes in another client', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const affectedKeys = [
      queryKeys.workspaces.detail('workspace-1'), queryKeys.workspaces.list('task-1'),
      queryKeys.workspaces.projectBranches('project-1'), queryKeys.tasks.detail('task-1'),
      queryKeys.workspaces.diff('workspace-1'), queryKeys.git.diff('/tmp/workspace-1', 'file.txt', 'committed'),
    ]
    for (const key of affectedKeys) queryClient.setQueryData(key, { old: true })
    const unrelatedKey = queryKeys.workspaces.detail('workspace-2')
    queryClient.setQueryData(unrelatedKey, { old: true })
    syncVisibleWorkspaceGitQueries(queryClient, {
      workspaceId: 'workspace-1', taskId: 'task-1', projectId: 'project-1',
      workingDir: '/tmp/workspace-1', reason: 'base-branch',
    }, null)
    for (const key of affectedKeys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBe(false)
    queryClient.clear()
  })

  it('invalidates only changes/status when the changed workspace is visible on the Changes tab', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    queryClient.setQueryData(queryKeys.git.changes('/tmp/workspace-1'), { uncommitted: [], committed: [] })
    queryClient.setQueryData(queryKeys.git.diff('/tmp/workspace-1', 'file.txt', 'uncommitted'), { diff: 'old' })
    queryClient.setQueryData(queryKeys.git.log('/tmp/workspace-1'), { commits: [] })
    queryClient.setQueryData(queryKeys.git.changes('/tmp/workspace-2'), { uncommitted: [], committed: [] })
    queryClient.setQueryData(queryKeys.workspaces.gitStatus('workspace-1'), { operation: 'idle' })
    queryClient.setQueryData(queryKeys.workspaces.diff('workspace-1'), { diff: 'old' })

    syncVisibleWorkspaceGitQueries(queryClient, {
      workspaceId: 'workspace-1',
      workingDir: '/tmp/workspace-1',
    }, {
      workspaceId: 'workspace-1',
      workingDir: '/tmp/workspace-1',
      tab: 'changes',
    })

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.git.changes('/tmp/workspace-1') })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.workspaces.gitStatus('workspace-1') })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.git.log('/tmp/workspace-1'),
      refetchType: 'none',
    })
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.git.log('/tmp/workspace-1') })
    expect(queryClient.getQueryState(queryKeys.git.diff('/tmp/workspace-1', 'file.txt', 'uncommitted'))?.isInvalidated).toBe(false)
    expect(queryClient.getQueryState(queryKeys.git.changes('/tmp/workspace-2'))?.isInvalidated).toBe(false)
    expect(queryClient.getQueryState(queryKeys.workspaces.diff('workspace-1'))?.isInvalidated).toBe(false)
  })

  it('invalidates only log when the changed workspace is visible on the History tab', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    queryClient.setQueryData(queryKeys.git.changes('/tmp/workspace-1'), { uncommitted: [], committed: [] })
    queryClient.setQueryData(queryKeys.git.log('/tmp/workspace-1'), { commits: [] })
    queryClient.setQueryData(queryKeys.workspaces.gitStatus('workspace-1'), { operation: 'idle' })

    syncVisibleWorkspaceGitQueries(queryClient, {
      workspaceId: 'workspace-1',
      workingDir: '/tmp/workspace-1',
    }, {
      workspaceId: 'workspace-1',
      workingDir: '/tmp/workspace-1',
      tab: 'history',
    })

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.git.log('/tmp/workspace-1') })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.git.changes('/tmp/workspace-1'),
      refetchType: 'none',
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.workspaces.gitStatus('workspace-1'),
      refetchType: 'none',
    })
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.git.changes('/tmp/workspace-1') })
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.workspaces.gitStatus('workspace-1') })
  })

  it('does not invalidate when there is no visible matching git tab', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    queryClient.setQueryData(queryKeys.git.changes('/tmp/workspace-1'), { uncommitted: [], committed: [] })

    syncVisibleWorkspaceGitQueries(queryClient, {
      workspaceId: 'workspace-1',
      workingDir: '/tmp/workspace-1',
    }, {
      workspaceId: 'workspace-2',
      workingDir: '/tmp/workspace-2',
      tab: 'changes',
    })
    syncVisibleWorkspaceGitQueries(queryClient, {
      workspaceId: 'workspace-1',
      workingDir: '/tmp/workspace-1',
    }, null)

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.git.changes('/tmp/workspace-1'),
      refetchType: 'none',
    })
    expect(queryClient.getQueryState(queryKeys.git.changes('/tmp/workspace-1'))?.isInvalidated).toBe(true)
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
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    invalidateAllGitRealtimeQueries(queryClient)

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.git.all, refetchType: 'none' })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['workspaces', 'gitStatus'], refetchType: 'none' })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['workspaces', 'diff'], refetchType: 'none' })
    expect(queryClient.getQueryState(queryKeys.git.changes('/tmp/workspace-1'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.workspaces.gitStatus('workspace-1'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.workspaces.gitStatus('workspace-2'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.workspaces.diff('workspace-1'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.workspaces.detail('workspace-1'))?.isInvalidated).toBe(false)
  })
})
