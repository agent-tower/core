import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Conversation,
  ConversationCreateInput,
  ConversationMessageInput,
} from '@agent-tower/shared'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'

export function useConversations(limit = 50) {
  return useQuery({
    queryKey: queryKeys.conversations.list({ limit }),
    queryFn: () => apiClient.get<Conversation[]>('/conversations', {
      params: { limit: String(limit) },
    }),
  })
}

export function useConversation(id?: string | null) {
  return useQuery({
    queryKey: queryKeys.conversations.detail(id ?? ''),
    queryFn: () => apiClient.get<Conversation>(`/conversations/${id}`),
    enabled: Boolean(id),
  })
}

export function useCreateConversation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: ConversationCreateInput) =>
      apiClient.post<Conversation>('/conversations', input),
    onSuccess: (conversation) => {
      queryClient.setQueryData(
        queryKeys.conversations.detail(conversation.id),
        conversation,
      )
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(conversation.sessionId) })
    },
  })
}

export function useSendConversationMessage() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & ConversationMessageInput) =>
      apiClient.post<Conversation>(`/conversations/${id}/message`, input),
    onSuccess: (conversation) => {
      queryClient.setQueryData(
        queryKeys.conversations.detail(conversation.id),
        conversation,
      )
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(conversation.sessionId) })
    },
  })
}

export function useStopConversation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<Conversation>(`/conversations/${id}/stop`),
    onSuccess: (conversation) => {
      queryClient.setQueryData(
        queryKeys.conversations.detail(conversation.id),
        conversation,
      )
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(conversation.sessionId) })
    },
  })
}

export function useDeleteConversation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => apiClient.delete<void>(`/conversations/${id}`),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.conversations.detail(id) })
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all })
    },
  })
}
