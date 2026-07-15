import { getApiBaseUrl } from '@/lib/api-base-url'

export type MessageResource =
  | { type: 'external'; url: string }
  | { type: 'internal'; url: string }
  | { type: 'workspace-file'; path: string }
  | { type: 'attachment'; path: string; url: string }
  | { type: 'unknown-local'; path: string }

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/
const LOCAL_ARTIFACT_PATH_SEGMENT = /[/\\](attachments|conversations)[/\\]/
const UNIX_FILE_ROOT = /^\/(Users|home|tmp|private|var|opt|mnt|Volumes)(\/|$)/

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

function relativeWorkspacePath(url: string, workingDir?: string): string | null {
  if (!workingDir) return null

  const normalizedUrl = normalizePath(url)
  const normalizedWorkingDir = normalizePath(workingDir).replace(/\/$/, '')
  if (normalizedUrl === normalizedWorkingDir) return null
  if (normalizedUrl.startsWith(`${normalizedWorkingDir}/`)) {
    return normalizedUrl.slice(normalizedWorkingDir.length + 1)
  }

  if (normalizedUrl.startsWith('./')) return normalizedUrl.slice(2)
  if (!normalizedUrl.startsWith('/') && !WINDOWS_ABSOLUTE_PATH.test(url) && !normalizedUrl.startsWith('../')) {
    return normalizedUrl
  }
  return null
}

function attachmentUrl(path: string): string {
  return `${getApiBaseUrl()}/attachments/by-path?path=${encodeURIComponent(path)}`
}

export function resolveMessageResource(url: string, workingDir?: string): MessageResource {
  if (/^https?:\/\//i.test(url)) return { type: 'external', url }
  if (/^(mailto|tel):/i.test(url)) return { type: 'external', url }
  if (url.startsWith('/api/') || url.startsWith('#')) return { type: 'internal', url }

  const workspacePath = relativeWorkspacePath(url, workingDir)
  if (workspacePath) return { type: 'workspace-file', path: workspacePath }

  if (LOCAL_ARTIFACT_PATH_SEGMENT.test(url)) {
    return { type: 'attachment', path: url, url: attachmentUrl(url) }
  }

  if (UNIX_FILE_ROOT.test(url) || WINDOWS_ABSOLUTE_PATH.test(url)) {
    return { type: 'unknown-local', path: url }
  }

  return { type: 'internal', url }
}

export function workspaceImageUrl(workingDir: string, filePath: string): string {
  const params = new URLSearchParams({ workingDir, path: filePath })
  return `${getApiBaseUrl()}/files/image?${params.toString()}`
}

export function localImageUrl(filePath: string): string {
  const params = new URLSearchParams({ path: filePath })
  return `${getApiBaseUrl()}/files/image?${params.toString()}`
}
