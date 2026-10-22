// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { useCreateTaskTeamRun, teamRunQueryKeys } from '../use-team-run'
import { pendingTeamInitialSubmission, rememberTeamInitialSubmission } from '../team-initial-submission'
const api = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ apiClient: api, ApiError: class extends Error {} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { sessionStorage.clear(); vi.resetAllMocks(); vi.unstubAllGlobals() })
it.each([true, false])('replays exact creation body after lost response and caches 202 as pending (native UUID=%s)', async nativeUuid => {
  if (!nativeUuid) vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  let mutation!: ReturnType<typeof useCreateTaskTeamRun>
  function App() { const next = useCreateTaskTeamRun(); useEffect(() => { mutation = next }, [next]); return null }
  await act(async () => root.render(<QueryClientProvider client={client}><App /></QueryClientProvider>))
  const input = { taskId: 'task', mode: 'CONFIRM' as const, memberPresetIds: ['original-preset'] }
  api.post.mockRejectedValueOnce(new Error('response lost')).mockImplementation(async (_url, body) => ({ operationId: 'operation', state: 'WAITING_TRANSLATION', destination: { kind: 'TEAM_ROOM_PENDING', taskId: 'task', plannedTeamRunId: 'planned' }, delivery: {
    origin: 'TEAM_INITIAL', destination: { kind: 'TEAM_ROOM_PENDING', taskId: 'task', plannedTeamRunId: 'planned' }, id: 'operation', clientSubmissionId: body.clientSubmissionId, sequence: 1, originalText: 'Original Task', attachmentIds: [], state: 'WAITING_TRANSLATION', revision: 1,
  } }))
  try {
    await act(async () => { await expect(mutation.mutateAsync(input)).rejects.toThrow('response lost') })
    const saved = structuredClone(api.post.mock.calls[0]![1]); expect(pendingTeamInitialSubmission('task')).toEqual(saved)
    await act(async () => { await mutation.mutateAsync({ taskId: 'task', ...pendingTeamInitialSubmission('task')! }) })
    expect(api.post.mock.calls[1]![1]).toEqual(saved); expect(pendingTeamInitialSubmission('task')).toBeNull()
    expect(client.getQueryData(teamRunQueryKeys.task('task'))).toBeUndefined(); expect(client.getQueryData(teamRunQueryKeys.detail('planned'))).toBeUndefined()
    expect(JSON.stringify(client.getQueryData(['message-deliveries', 'task:task', 'pending']))).toContain('operation')
  } finally { await act(async () => root.unmount()); host.remove(); client.clear() }
})
it('keeps an unknown creation separate from new configuration and fails closed on damaged storage', () => {
  const old = rememberTeamInitialSubmission('task', { mode: 'AUTO', memberPresetIds: ['old'] })
  expect(() => rememberTeamInitialSubmission('task', { mode: 'CONFIRM', memberPresetIds: ['new'] })).toThrow('original team creation')
  expect(pendingTeamInitialSubmission('task')).toEqual(old)
  sessionStorage.setItem('tower:team-initial-submission:task', 'null')
  expect(() => rememberTeamInitialSubmission('task', { mode: 'AUTO', memberPresetIds: ['new'] })).toThrow('damaged')
  expect(sessionStorage.getItem('tower:team-initial-submission:task')).toBe('null')
})
