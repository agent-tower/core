import { useEffect } from 'react'
import { acknowledgeUserSubmission } from './user-submission'
import type { Conversation } from '@agent-tower/shared'
import { queryKeys } from './query-keys'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { MessageDeliverySubmission } from '@agent-tower/shared'
import { apiClient } from '@/lib/api-client'
import { cacheDelivery } from './delivery-cache'

export interface OutgoingSubmission { id: string; scope: string; path: string; body: object & { clientSubmissionId: string }; text: string; createdAt: string; failed: boolean }
const prefix = 'tower:outgoing:'
const key = (scope: string) => ['outgoing-submissions', scope] as const
function read(scope: string): OutgoingSubmission[] {
  try {
    const items: unknown = JSON.parse(sessionStorage.getItem(prefix + scope) ?? '[]')
    return Array.isArray(items) ? items.filter((item): item is OutgoingSubmission => item && item.scope === scope && typeof item.id === 'string' && typeof item.path === 'string' && typeof item.text === 'string' && item.body?.clientSubmissionId === item.id).map(item => ({ ...item, failed: true })) : []
  } catch { return [] }
}
function write(client: QueryClient, scope: string, update: (items: OutgoingSubmission[]) => OutgoingSubmission[]) {
  const items = update(client.getQueryData<OutgoingSubmission[]>(key(scope)) ?? read(scope))
  client.setQueryData(key(scope), items)
  try { sessionStorage.setItem(prefix + scope, JSON.stringify(items)) } catch { /* The submission UUID is also owned by userSubmission. */ }
}
export function useOutgoingSubmissions(scope: string, acknowledged: readonly string[] = []) {
  const client = useQueryClient()
  const query = useQuery({ queryKey: key(scope), queryFn: () => read(scope), initialData: () => read(scope), staleTime: Infinity })
  useEffect(() => {
    const known = query.data.filter(item => acknowledged.includes(item.id))
    if (!known.length) return
    for (const item of known) acknowledgeUserSubmission(submissionKey(item), withoutId(item.body), item.id)
    write(client, scope, items => items.filter(item => !acknowledged.includes(item.id)))
  }, [client, scope, query.data, acknowledged])
  return query.data
}
/** Called inside userSubmission's UUID boundary, before the HTTP request. */
export async function submitOutgoing<T>(client: QueryClient, scope: string, path: string, body: object & { clientSubmissionId: string }, resolve?: (result: T) => Promise<T>): Promise<T> {
  const text = 'message' in body ? String(body.message) : 'prompt' in body ? String(body.prompt) : ''
  if ('systemAction' in body) return apiClient.post<T>(path, body)
  write(client, scope, items => [...items.filter(item => item.id !== body.clientSubmissionId), { id: body.clientSubmissionId, scope, path, body, text, createdAt: items.find(item => item.id === body.clientSubmissionId)?.createdAt ?? new Date().toISOString(), failed: false }])
  try {
    const received = await apiClient.post<T>(path, body)
    const result = resolve ? await resolve(received) : received
    if (result && typeof result === 'object' && 'operationId' in result) cacheDelivery(client, (result as MessageDeliverySubmission).delivery)
    write(client, scope, items => items.filter(item => item.id !== body.clientSubmissionId))
    return result
  } catch (error) {
    write(client, scope, items => items.map(item => item.id === body.clientSubmissionId ? { ...item, failed: true } : item))
    throw error
  }
}
function withoutId(body: OutgoingSubmission['body']) { return Object.fromEntries(Object.entries(body).filter(([field]) => field !== 'clientSubmissionId')) }
function submissionKey(item: OutgoingSubmission) {
  return item.path === '/conversations' ? 'conversation:create' : item.path.startsWith('/sessions/') ? `message:${item.scope}` : `conversation:message:${item.path.split('/')[2]}`
}
export async function resolveConversationSubmission(client: QueryClient, result: Conversation | MessageDeliverySubmission) {
  if ('operationId' in result && 'sessionId' in result) {
    cacheDelivery(client, result.delivery)
    return apiClient.get<Conversation>(`/conversations/${result.destinationId}`)
  }
  return result
}
export function useRetryOutgoing(item: OutgoingSubmission) {
  const client = useQueryClient()
  return useMutation({ mutationFn: () => retryOutgoing(client, item), onSuccess: result => {
    if (item.path === '/conversations' && 'id' in result) client.setQueryData(queryKeys.conversations.detail(result.id), result)
    return client.invalidateQueries()
  } })
}

/** Replay the atomic snapshot even if the separate original UUID cache was lost. */
export async function retryOutgoing(client: QueryClient, item: OutgoingSubmission) {
  const result = await submitOutgoing<Conversation | MessageDeliverySubmission>(client, item.scope, item.path, item.body, item.path === '/conversations' ? result => resolveConversationSubmission(client, result) : undefined)
  acknowledgeUserSubmission(submissionKey(item), withoutId(item.body), item.id)
  return result
}
