import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'

export type FileTreeItem = { name: string; type: 'file' | 'directory' }

export type FileTreeResponse = { items: FileTreeItem[] }

export type FileContentResponse = {
  content: string
  language: string
}

function inferLanguage(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'json':
      return 'json'
    case 'md':
    case 'mdx':
      return 'markdown'
    case 'css':
      return 'css'
    case 'scss':
      return 'scss'
    case 'html':
      return 'html'
    case 'yml':
    case 'yaml':
      return 'yaml'
    case 'sh':
      return 'shell'
    case 'py':
      return 'python'
    case 'go':
      return 'go'
    case 'rs':
      return 'rust'
    default:
      return 'plaintext'
  }
}

export function useFileTree(workingDir: string | undefined, dirPath: string) {
  return useQuery({
    queryKey: queryKeys.files.tree(workingDir || '', dirPath),
    queryFn: () =>
      apiClient.get<FileTreeResponse>('/files/tree', {
        params: {
          workingDir: workingDir || '',
          path: dirPath,
        },
      }),
    enabled: !!workingDir,
  })
}

export function useFileContent(
  workingDir: string | undefined,
  filePath: string | null
) {
  return useQuery({
    queryKey: queryKeys.files.content(workingDir || '', filePath || ''),
    queryFn: () =>
      apiClient.get<FileContentResponse>('/files/read', {
        params: {
          workingDir: workingDir || '',
          path: filePath || '',
        },
      }),
    enabled: !!workingDir && !!filePath,
  })
}

export function useSaveFile() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { workingDir: string; path: string; content: string }) =>
      apiClient.post<{ success: true }>('/files/write', input),
    onSuccess: (_data, variables) => {
      const key = queryKeys.files.content(variables.workingDir, variables.path)
      const existing = queryClient.getQueryData<FileContentResponse>(key)
      queryClient.setQueryData(key, {
        content: variables.content,
        language: existing?.language || inferLanguage(variables.path),
      } satisfies FileContentResponse)
    },
  })
}

