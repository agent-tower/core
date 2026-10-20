import { resolveConversationSubmission, submitOutgoing } from './outgoing-submissions'
import { cacheDelivery } from './delivery-cache'
import { userSubmission } from './user-submission'
import { deliveryKey } from './use-message-deliveries'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Conversation,
  ConversationCreateInput,
  ConversationMessageInput,
  SessionMessageDeliverySubmission,
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
      userSubmission('conversation:create', input, async body => {
        const result = await submitOutgoing<Conversation | SessionMessageDeliverySubmission>(queryClient, 'new-conversation', '/conversations', body, result => resolveConversationSubmission(queryClient, result) as Promise<Conversation | SessionMessageDeliverySubmission>)
        if ('operationId' in result) {
          cacheDelivery(queryClient, result.delivery)
          void queryClient.invalidateQueries({ queryKey: deliveryKey(result.sessionId) })
          return apiClient.get<Conversation>(`/conversations/${result.destinationId}`)
        }
        return result
      }),
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
    mutationFn: ({ id, sessionId, ...input }: { id: string; sessionId?: string } & ConversationMessageInput) =>
      userSubmission(`conversation:message:${id}`, input, async body => {
        const result = await submitOutgoing<Conversation | SessionMessageDeliverySubmission>(queryClient, sessionId ?? queryClient.getQueryData<Conversation>(queryKeys.conversations.detail(id))?.sessionId ?? `conversation:${id}`, `/conversations/${id}/message`, body)
        if ('operationId' in result) {
          cacheDelivery(queryClient, result.delivery)
          void queryClient.invalidateQueries({ queryKey: deliveryKey(result.sessionId) })
          return apiClient.get<Conversation>(`/conversations/${result.destinationId}`)
        }
        return result
      }),
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
    onSettled: (conversation, _error, id) => {
      const cached = queryClient.getQueryData<Conversation>(queryKeys.conversations.detail(id))
      const sessionId = conversation?.sessionId ?? cached?.sessionId
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(id) })
      if (sessionId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) })
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.runtime(sessionId) })
      }
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
