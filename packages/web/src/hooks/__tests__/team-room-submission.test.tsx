// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { usePostRoomMessage, teamRunQueryKeys } from '../use-team-run'
import { pendingTeamRoomSubmissions, rememberTeamRoomSubmission } from '../team-room-submission'

const api = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ apiClient: api }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { sessionStorage.clear(); vi.resetAllMocks() })
it('restores conflict assistance after lost response/reload with the same UUID, and treats 202 as pending', async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  let mutation!: ReturnType<typeof usePostRoomMessage>
  function App() { const next = usePostRoomMessage('team'); useEffect(() => { mutation = next }, [next]); return null }
  await act(async () => { root.render(<QueryClientProvider client={client}><App /></QueryClientProvider>) })
  const input = { content: 'Resolve conflict', kind: 'chat' as const, attachmentIds: ['old-attachment'] }
  api.post.mockRejectedValueOnce(new Error('response lost')).mockImplementation(async (_url, body) => ({ operationId: 'operation', state: 'WAITING_TRANSLATION', delivery: {
    origin: 'TEAM_USER', destination: { kind: 'TEAM_ROOM', taskId: 'task', teamRunId: 'team' }, id: 'operation', clientSubmissionId: body.clientSubmissionId, channelKey: 'task:task:team-room', sequence: 1, originalText: body.content, attachmentIds: body.attachmentIds, state: 'WAITING_TRANSLATION', revision: 1,
  } }))
  try {
    await act(async () => { await expect(mutation.mutateAsync(input)).rejects.toThrow('response lost') })
    const saved = structuredClone(api.post.mock.calls[0]![1])
    expect(pendingTeamRoomSubmissions('team')).toEqual([saved])
    await act(async () => { root.unmount() })
    const secondRoot = createRoot(host)
    await act(async () => { secondRoot.render(<QueryClientProvider client={client}><App /></QueryClientProvider>) })
    try {
      await act(async () => { await mutation.mutateAsync(input) })
      expect(api.post.mock.calls[1]![1]).toEqual(saved)
      expect(pendingTeamRoomSubmissions('team')).toEqual([])
      expect(client.getQueryData(teamRunQueryKeys.messages('team'))).toBeUndefined()
      expect(JSON.stringify(client.getQueryData(['message-deliveries', 'task:task', 'pending']))).toContain('operation')
      await act(async () => { await mutation.mutateAsync(input) })
      expect(api.post.mock.calls[2]![1].clientSubmissionId).not.toBe(saved.clientSubmissionId)
    } finally { await act(async () => { secondRoot.unmount() }) }
  } finally { host.remove(); client.clear() }
})
it('preserves original body and attachments when a caller reuses an unknown UUID with different intent', () => {
  const old = rememberTeamRoomSubmission('team', { content: 'original', attachmentIds: ['old'] })
  expect(() => rememberTeamRoomSubmission('team', { ...old, content: 'new draft', attachmentIds: ['new'] })).toThrow('original room submission')
  expect(pendingTeamRoomSubmissions('team')).toEqual([old])
  expect(rememberTeamRoomSubmission('team', { content: 'original', clientSubmissionId: crypto.randomUUID(), attachmentIds: ['old'] }).clientSubmissionId).not.toBe(old.clientSubmissionId)
})
it('fails closed on damaged pending storage before sending or replacing its identity', () => {
  sessionStorage.setItem('tower:team-room-submission:team:old', 'null')
  expect(() => rememberTeamRoomSubmission('team', { content: 'Resolve conflict' })).toThrow('unavailable or damaged')
  expect(sessionStorage.getItem('tower:team-room-submission:team:old')).toBe('null')
})
