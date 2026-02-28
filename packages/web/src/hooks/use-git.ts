import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'

export type GitChangeEntry = {
  status: string
  path: string
}

export type GitChangesResponse = {
  uncommitted: GitChangeEntry[]
  committed: GitChangeEntry[]
}

export type GitDiffResponse = {
  diff: string
}

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

export function useGitChanges(workingDir: string | undefined) {
  return useQuery({
    queryKey: queryKeys.git.changes(workingDir || ''),
    queryFn: () =>
      apiClient.get<GitChangesResponse>('/git/changes', {
        params: { workingDir: workingDir || '' },
      }),
    enabled: !!workingDir,
  })
}

export function useGitDiff(
  workingDir: string | undefined,
  filePath: string | null,
  type: 'uncommitted' | 'committed'
) {
  return useQuery({
    queryKey: queryKeys.git.diff(workingDir || '', filePath || '', type),
    queryFn: () =>
      apiClient.get<GitDiffResponse>('/git/diff', {
        params: {
          workingDir: workingDir || '',
          path: filePath || '',
          type,
        },
      }),
    enabled: !!workingDir && !!filePath,
  })
}

export function useGitLog(workingDir: string | undefined) {
  return useQuery({
    queryKey: queryKeys.git.log(workingDir || ''),
    queryFn: () =>
      apiClient.get<GitLogResponse>('/git/log', {
        params: { workingDir: workingDir || '', limit: '50' },
      }),
    enabled: !!workingDir,
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

export function useGitCommitDiff(workingDir: string | undefined, hash: string | null, filePath: string | null) {
  return useQuery({
    queryKey: queryKeys.git.commitDiff(workingDir || '', hash || '', filePath || ''),
    queryFn: () =>
      apiClient.get<GitDiffResponse>('/git/commit-diff', {
        params: { workingDir: workingDir || '', hash: hash || '', path: filePath || '' },
      }),
    enabled: !!workingDir && !!hash && !!filePath,
  })
}
