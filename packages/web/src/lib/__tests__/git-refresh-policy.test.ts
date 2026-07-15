import { describe, expect, it } from 'vitest'
import {
  GIT_CHANGES_REFRESH_INTERVAL_MS,
  GIT_HISTORY_REFRESH_INTERVAL_MS,
  GIT_STATUS_REFRESH_INTERVAL_MS,
  getGitChangesRefreshInterval,
  getGitHistoryRefreshInterval,
  getGitStatusRefreshInterval,
} from '../git-refresh-policy'

const changesContext = {
  workspaceId: 'workspace-1',
  workingDir: '/tmp/workspace-1',
  tab: 'changes' as const,
}

const historyContext = {
  ...changesContext,
  tab: 'history' as const,
}

describe('git refresh policy', () => {
  it('polls changes and status only for the visible Changes workspace', () => {
    expect(getGitChangesRefreshInterval('/tmp/workspace-1', changesContext))
      .toBe(GIT_CHANGES_REFRESH_INTERVAL_MS)
    expect(getGitStatusRefreshInterval('workspace-1', changesContext))
      .toBe(GIT_STATUS_REFRESH_INTERVAL_MS)

    expect(getGitChangesRefreshInterval('/tmp/workspace-2', changesContext)).toBe(false)
    expect(getGitStatusRefreshInterval('workspace-2', changesContext)).toBe(false)
    expect(getGitChangesRefreshInterval('/tmp/workspace-1', historyContext)).toBe(false)
    expect(getGitStatusRefreshInterval('workspace-1', historyContext)).toBe(false)
  })

  it('polls history only for the visible History workspace', () => {
    expect(getGitHistoryRefreshInterval('/tmp/workspace-1', historyContext))
      .toBe(GIT_HISTORY_REFRESH_INTERVAL_MS)
    expect(getGitHistoryRefreshInterval('/tmp/workspace-2', historyContext)).toBe(false)
    expect(getGitHistoryRefreshInterval('/tmp/workspace-1', changesContext)).toBe(false)
  })

  it('does not poll without a visible Git context', () => {
    expect(getGitChangesRefreshInterval('/tmp/workspace-1', null)).toBe(false)
    expect(getGitStatusRefreshInterval('workspace-1', null)).toBe(false)
    expect(getGitHistoryRefreshInterval('/tmp/workspace-1', null)).toBe(false)
  })
})
