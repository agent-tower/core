import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/hooks/query-keys'
import {
  invalidateAllGitRealtimeQueries,
  syncWorkspaceGitChangedQueries,
} from '../hooks/useWorkspaceGitRealtimeSync'

describe('syncWorkspaceGitChangedQueries', () => {
  it('refreshes saved workspace metadata when the base branch changes in another client; file diffs follow their tokens', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
    const affectedKeys = [
      queryKeys.workspaces.detail('workspace-1'), queryKeys.workspaces.list('task-1'),
      queryKeys.workspaces.projectBranches('project-1'), queryKeys.tasks.detail('task-1'),
      queryKeys.workspaces.diff('workspace-1'),
    ]
    for (const key of affectedKeys) queryClient.setQueryData(key, { old: true })
    // A new base changes the committed entries' tokens, so their diffs come under new keys.
    const keptKeys = [
      queryKeys.workspaces.detail('workspace-2'),
      queryKeys.gitDiffs.file('/tmp/workspace-1', 'committed', 'file.txt', 'token-1', false),
    ]
    for (const key of keptKeys) queryClient.setQueryData(key, { old: true })
    syncWorkspaceGitChangedQueries(queryClient, {
      workspaceId: 'workspace-1', taskId: 'task-1', projectId: 'project-1',
      workingDir: '/tmp/workspace-1', reason: 'base-branch',
    }, () => false)
    for (const key of affectedKeys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
    for (const key of keptKeys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false)
    queryClient.clear()
  })

  it('leaves git queries of a workspace with a live subscription to the pushed state', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    })
    const keys = [
      queryKeys.git.changes('/tmp/workspace-1'),
      queryKeys.git.log('/tmp/workspace-1'),
      queryKeys.workspaces.gitStatus('workspace-1'),
      queryKeys.gitDiffs.file('/tmp/workspace-1', 'uncommitted', 'file.txt', 'token-1', false),
    ]
    for (const key of keys) queryClient.setQueryData(key, { old: true })
    const isLive = vi.fn((workspaceId: string) => workspaceId === 'workspace-1')

    syncWorkspaceGitChangedQueries(queryClient, {
      workspaceId: 'workspace-1',
      workingDir: '/tmp/workspace-1',
      reason: 'worktree',
    }, isLive)

    expect(isLive).toHaveBeenCalledWith('workspace-1')
    for (const key of keys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false)
    queryClient.clear()
  })

  it('invalidates changes, history and status of a workspace without a live subscription', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    queryClient.setQueryData(queryKeys.git.changes('/tmp/workspace-1'), { uncommitted: [], committed: [] })
    queryClient.setQueryData(queryKeys.git.log('/tmp/workspace-1'), { commits: [] })
    queryClient.setQueryData(queryKeys.workspaces.gitStatus('workspace-1'), { operation: 'idle' })
    queryClient.setQueryData(queryKeys.gitDiffs.file('/tmp/workspace-1', 'uncommitted', 'file.txt', 'token-1', false), { kind: 'text', token: 'token-1', diff: 'old' })
    queryClient.setQueryData(queryKeys.git.changes('/tmp/workspace-2'), { uncommitted: [], committed: [] })

    syncWorkspaceGitChangedQueries(queryClient, {
      workspaceId: 'workspace-1',
      workingDir: '/tmp/workspace-1',
      reason: 'worktree',
    }, () => false)

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.git.changes('/tmp/workspace-1') })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.git.log('/tmp/workspace-1') })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.workspaces.gitStatus('workspace-1') })
    expect(queryClient.getQueryState(queryKeys.gitDiffs.file('/tmp/workspace-1', 'uncommitted', 'file.txt', 'token-1', false))?.isInvalidated).toBe(false)
    expect(queryClient.getQueryState(queryKeys.git.changes('/tmp/workspace-2'))?.isInvalidated).toBe(false)
    queryClient.clear()
  })

  it('ignores a hint without workspace and directory', () => {
    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    syncWorkspaceGitChangedQueries(queryClient, { workspaceId: 'workspace-1' }, () => false)
    syncWorkspaceGitChangedQueries(queryClient, null, () => false)
    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it('invalidates workspace git status and diff queries for reconnect fallback; file diffs keep their keys', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity } },
    })
    const fileDiff = queryKeys.gitDiffs.file('/tmp/workspace-1', 'uncommitted', 'file.txt', 'token-1', false)
    const commitDiff = queryKeys.gitDiffs.commit('/tmp/workspace-1', 'abc123', 'file.txt')
    queryClient.setQueryData(fileDiff, { kind: 'text', token: 'token-1', diff: 'old' })
    queryClient.setQueryData(commitDiff, { diff: 'old' })
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
    expect(queryClient.getQueryState(fileDiff)?.isInvalidated).toBe(false)
    expect(queryClient.getQueryState(commitDiff)?.isInvalidated).toBe(false)
  })
})
