import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GitFileDiffResponse } from '@agent-tower/shared'
import { apiClient } from '@/lib/api-client'
import { getWorkspaceGitSubscriptions, gitRestRefetchOptions } from '@/lib/socket/workspace-git-subscriptions'
import { queryKeys } from './query-keys'

export type GitChangeEntry = {
  status: string
  path: string
  additions?: number
  deletions?: number
  /** Version of the file's diff (change lists only); compared for equality only. */
  token?: string
}

export type GitChangesResponse = {
  uncommitted: GitChangeEntry[]
  committed: GitChangeEntry[]
}

/** One working file's diff: a text diff, a binary file, or a file above the size limit. */
export type GitDiffResponse = GitFileDiffResponse

export type GitCommitDiffResponse = {
  diff: string
}

/**
 * A diff never changes under its key, so it is fetched once per key: never stale, and not
 * refetched on window focus, reconnect or remount.
 */
const IMMUTABLE_QUERY = {
  staleTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const

export type GitLogEntry = {
  hash: string
  shortHash: string
  author: string
  email: string
  timestamp: number
  message: string
  body: string
}

export type GitLogResponse = {
  commits: GitLogEntry[]
}

export type GitCommitFilesResponse = {
  files: GitChangeEntry[]
}

/**
 * Git queries load once over REST. While the task's workspace subscription is live
 * (`useWorkspaceGitSubscription`), pushes keep them current; otherwise they refetch on window
 * focus and reconnect. None of them polls.
 */
function useWorkingDirRefetchOptions(workingDir: string | undefined) {
  const subscriptions = getWorkspaceGitSubscriptions(useQueryClient())
  return gitRestRefetchOptions(() => subscriptions.coversWorkingDir(workingDir))
}

export function useGitChanges(workingDir: string | undefined, options: { enabled?: boolean } = {}) {
  const refetchOptions = useWorkingDirRefetchOptions(workingDir)

  return useQuery({
    queryKey: queryKeys.git.changes(workingDir || ''),
    queryFn: () =>
      apiClient.get<GitChangesResponse>('/git/changes', {
        params: { workingDir: workingDir || '' },
      }),
    enabled: !!workingDir && (options.enabled ?? true),
    ...refetchOptions,
  })
}

/**
 * One working file's diff, keyed by the file's version token from the change list (pushed state or
 * `GET /git/changes`): a new token is a new query, an unchanged token is answered from the cache.
 * While a new version loads, the previous answer stays on screen. Unmounting the last card that
 * shows it aborts the request, and the server stops its git work. `force` asks for files above
 * the default size limit ("load anyway").
 */
export function useGitDiff(
  workingDir: string | undefined,
  filePath: string | null,
  type: 'uncommitted' | 'committed',
  token: string | undefined,
  options: { force?: boolean } = {},
) {
  const force = options.force === true
  return useQuery({
    queryKey: queryKeys.gitDiffs.file(workingDir || '', type, filePath || '', token ?? '', force),
    queryFn: ({ signal }) =>
      apiClient.get<GitDiffResponse>('/git/diff', {
        params: {
          workingDir: workingDir || '',
          path: filePath || '',
          type,
          ...(force ? { force: '1' } : {}),
        },
        signal,
      }),
    enabled: !!workingDir && !!filePath,
    placeholderData: keepPreviousData,
    // A failed diff is not asked again for the same version; reopening the card retries.
    retry: false,
    ...IMMUTABLE_QUERY,
  })
}

export const GIT_LOG_PAGE_SIZE = 50

/**
 * Paged commit history. HistoryView, MobileHistoryView and the Changes tab's commit timeline share
 * `queryKeys.git.log(workingDir)`, so they must also share the page size and the refetch options.
 */
export function useGitLogPages(workingDir: string | undefined) {
  const refetchOptions = useWorkingDirRefetchOptions(workingDir)

  return useInfiniteQuery({
    queryKey: queryKeys.git.log(workingDir || ''),
    queryFn: ({ pageParam = 0 }) =>
      apiClient.get<GitLogResponse>('/git/log', {
        params: { workingDir: workingDir || '', limit: String(GIT_LOG_PAGE_SIZE), skip: String(pageParam) },
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.commits.length < GIT_LOG_PAGE_SIZE ? undefined : allPages.length * GIT_LOG_PAGE_SIZE,
    enabled: !!workingDir,
    ...refetchOptions,
  })
}

export function useGitCommitFiles(workingDir: string | undefined, hash: string | null) {
  return useQuery({
    queryKey: queryKeys.git.commitFiles(workingDir || '', hash || ''),
    queryFn: () =>
      apiClient.get<GitCommitFilesResponse>('/git/commit-files', {
        params: { workingDir: workingDir || '', hash: hash || '' },
      }),
    enabled: !!workingDir && !!hash,
  })
}

/** A file's diff in one commit: it never changes, so it never refetches. */
export function useGitCommitDiff(workingDir: string | undefined, hash: string | null, filePath: string | null) {
  return useQuery({
    queryKey: queryKeys.gitDiffs.commit(workingDir || '', hash || '', filePath || ''),
    queryFn: ({ signal }) =>
      apiClient.get<GitCommitDiffResponse>('/git/commit-diff', {
        params: { workingDir: workingDir || '', hash: hash || '', path: filePath || '' },
        signal,
      }),
    enabled: !!workingDir && !!hash && !!filePath,
    ...IMMUTABLE_QUERY,
  })
}
