import type { VisibleGitContext } from '@/stores/git-visibility-store'

export const GIT_CHANGES_REFRESH_INTERVAL_MS = 1_500
export const GIT_STATUS_REFRESH_INTERVAL_MS = 2_000
export const GIT_HISTORY_REFRESH_INTERVAL_MS = 5_000

export function getGitChangesRefreshInterval(
  workingDir: string | undefined,
  visibleContext: VisibleGitContext | null,
): number | false {
  return workingDir
    && visibleContext?.workingDir === workingDir
    && visibleContext.tab === 'changes'
    ? GIT_CHANGES_REFRESH_INTERVAL_MS
    : false
}

export function getGitStatusRefreshInterval(
  workspaceId: string,
  visibleContext: VisibleGitContext | null,
): number | false {
  return workspaceId
    && visibleContext?.workspaceId === workspaceId
    && visibleContext.tab === 'changes'
    ? GIT_STATUS_REFRESH_INTERVAL_MS
    : false
}

export function getGitHistoryRefreshInterval(
  workingDir: string | undefined,
  visibleContext: VisibleGitContext | null,
): number | false {
  return workingDir
    && visibleContext?.workingDir === workingDir
    && visibleContext.tab === 'history'
    ? GIT_HISTORY_REFRESH_INTERVAL_MS
    : false
}
