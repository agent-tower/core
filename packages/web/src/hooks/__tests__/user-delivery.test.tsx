import { retryOutgoing, submitOutgoing } from '../outgoing-submissions'
// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { MessageDelivery, MessageDeliverySubmission, SessionMessageDelivery } from '@agent-tower/shared'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { userSubmission } from '../user-submission'
import { taskStartSubmission } from '../task-start-submission'
import { cacheDelivery, mergeDeliveryPages } from '../delivery-cache'
import { useCreateConversation } from '../use-conversations'
import { queryKeys } from '../query-keys'

const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ apiClient: api }))
vi.mock('@/lib/socket/manager', () => ({ socketManager: { connect: () => ({ on: vi.fn(), off: vi.fn() }) } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { sessionStorage.clear(); vi.resetAllMocks(); vi.unstubAllGlobals() })
const operation = (state: MessageDelivery['state'] = 'WAITING_TRANSLATION', revision = 1): Extract<SessionMessageDelivery, { origin: 'CONVERSATION' }> => ({
  id: 'delivery', clientSubmissionId: 'client', sessionId: 'session', conversationId: 'conversation', channelKey: 'conversation:conversation', sequence: 1,
  origin: 'CONVERSATION', destination: { kind: 'CONVERSATION', sessionId: 'session', conversationId: 'conversation' }, originalText: 'User original', attachmentIds: ['attachment'], state, sentMode: null, acceptedText: null, actualSentText: null, sentAt: null,
  acceptedDestinationId: null, lastError: null, revision, createdAt: new Date().toISOString(),
})

describe('user delivery identities and cache', () => {
  it('replays the atomic outgoing UUID when the separate submission identity has been lost', async () => {
    const client = new QueryClient()
    const id = crypto.randomUUID()
    const body = { message: 'original', attachmentIds: ['original-file'], clientSubmissionId: id }
    api.post.mockResolvedValue({ operationId: 'delivery', delivery: operation() })
    await retryOutgoing(client, { id, scope: 'session', path: '/sessions/session/message', body, text: 'original', failed: true, createdAt: new Date().toISOString() })
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/sessions/session/message', body)
    client.clear()
  })
  it('shows the immutable submission before HTTP settles and retains its UUID and attachment snapshot for list retry', async () => {
    const client = new QueryClient()
    let reject!: (error: Error) => void
    api.post.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const input = { message: 'Submitted original', attachmentIds: ['old-file'] }
    const pending = userSubmission('message:session', input, body => submitOutgoing(client, 'session', '/sessions/session/message', body))
    const shown = client.getQueryData<Array<{ body: object; text: string; failed: boolean }>>(['outgoing-submissions', 'session'])!
    expect(shown).toMatchObject([{ text: 'Submitted original', failed: false, body: { ...input } }])
    reject(new Error('lost response')); await expect(pending).rejects.toThrow('lost response')
    expect(client.getQueryData(['outgoing-submissions', 'session'])).toMatchObject([{ failed: true, body: shown[0].body }])
    api.post.mockResolvedValueOnce({ operationId: 'delivery', delivery: operation() })
    await userSubmission('message:session', input, body => submitOutgoing(client, 'session', '/sessions/session/message', body))
    expect(api.post.mock.calls[1][1]).toEqual(api.post.mock.calls[0][1])
    expect(client.getQueryData(['outgoing-submissions', 'session'])).toEqual([])
    client.clear()
  })

  it.each([true, false])('retains the exact submission UUID after response loss, then allows a new identical message (native UUID=%s)', async nativeUuid => {
    const key = crypto.randomUUID(); const input = { message: 'original', attachmentIds: ['attachment'] }
    if (!nativeUuid) vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    const send = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValue({ ok: true })
    await expect(userSubmission(key, input, send)).rejects.toThrow('lost response')
    expect(send.mock.calls[0][0].clientSubmissionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    await userSubmission(key, input, send)
    expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0])
    await userSubmission(key, input, send)
    expect(send.mock.calls[2][0].clientSubmissionId).not.toBe(send.mock.calls[0][0].clientSubmissionId)
  })

  it('keeps UUID and original capability after a lost system response, including reload and changed signature', async () => {
    const key = crypto.randomUUID(); const input = { message: 'conflict intent', systemAction: 'resolve_conflicts', resolutionContextToken: 'old-process-signature' }
    const send = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({ ok: true })
    await expect(userSubmission(key, input, send)).rejects.toThrow('response lost')
    await userSubmission(key, { ...input, resolutionContextToken: 'new-signature' }, send)
    expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0])
    const other = crypto.randomUUID(); const denied = vi.fn().mockRejectedValueOnce({ details: { accepted: false } }).mockResolvedValue({ ok: true })
    await expect(userSubmission(other, input, denied)).rejects.toMatchObject({ details: { accepted: false } })
    await userSubmission(other, { ...input, resolutionContextToken: 'read-only-refreshed' }, denied)
    expect(denied.mock.calls[1][0].clientSubmissionId).toBe(denied.mock.calls[0][0].clientSubmissionId)
    expect(denied.mock.calls[1][0].resolutionContextToken).toBe('read-only-refreshed')
  })

  it('adopts a pre-upgrade pending system UUID even after the signature changed', async () => {
    const key = crypto.randomUUID(); const id = crypto.randomUUID()
    const old = { message: 'old conflict', systemAction: 'resolve_conflicts', resolutionContextToken: 'old-key' }
    sessionStorage.setItem(`tower:user-submission:${key}:${JSON.stringify(old)}`, id)
    const send = vi.fn().mockResolvedValue({ ok: true })
    await userSubmission(key, { ...old, resolutionContextToken: 'new-key' }, send)
    expect(send).toHaveBeenCalledWith({ ...old, clientSubmissionId: id })
    expect(sessionStorage.length).toBe(0)
  })

  it('keeps a stable operation identity across reload and signature changes, but separates a new Git operation', async () => {
    const makeToken = (operationId: string, signature: string) => `${btoa(JSON.stringify({ actor: 'owner', operationId, context: { sourceWorkspaceId: 'source' } }))}.${signature}`
    const key = `message:${crypto.randomUUID()}`; const operationId = crypto.randomUUID()
    const input = { message: 'system intent', systemAction: 'resolve_conflicts', resolutionContextToken: makeToken(operationId, 'old') }
    const lost = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue({ ok: true })
    await expect(userSubmission(key, input, lost)).rejects.toThrow('lost')
    const stored = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i)).find(value => value?.startsWith('tower:system-submission:'))!
    expect(JSON.parse(sessionStorage.getItem(stored)!)).toMatchObject({ id: lost.mock.calls[0][0].clientSubmissionId, body: input })
    vi.resetModules()
    const reloaded = (await import('../user-submission')).userSubmission
    await reloaded(key, { ...input, resolutionContextToken: makeToken(operationId, 'new') }, lost)
    expect(lost.mock.calls[1][0]).toEqual(lost.mock.calls[0][0])
    const newer = vi.fn().mockResolvedValue({ ok: true })
    await reloaded(key, { ...input, resolutionContextToken: makeToken(crypto.randomUUID(), 'next-operation') }, newer)
    expect(newer.mock.calls[0][0].clientSubmissionId).not.toBe(lost.mock.calls[0][0].clientSubmissionId)
  })

  it('rejects a damaged pending record without crashing recovery or replacing the uncertain UUID', async () => {
    const input = { message: 'conflict', systemAction: 'resolve_conflicts', resolutionContextToken: `${btoa(JSON.stringify({ actor: crypto.randomUUID(), operationId: crypto.randomUUID(), context: { sourceWorkspaceId: 'source' } }))}.old` }
    const key = `message:${crypto.randomUUID()}`; const send = vi.fn().mockRejectedValue(new Error('lost'))
    await expect(userSubmission(key, input, send)).rejects.toThrow('lost')
    const stored = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i)).find(value => value?.startsWith('tower:system-submission:'))!
    sessionStorage.setItem(stored, 'null'); vi.resetModules()
    const reloaded = await import('../user-submission')
    expect(() => reloaded.pendingConflictReceiver(input.resolutionContextToken)).not.toThrow()
    await expect(reloaded.userSubmission(key, input, send)).rejects.toThrow('unavailable or damaged')
    expect(send).toHaveBeenCalledTimes(1); expect(sessionStorage.getItem(stored)).toBe('null')
  })

  it('blocks a new observation or receiver from bypassing an unknown request after reload and display cleanup', async () => {
    const actor = crypto.randomUUID()
    const token = (operationId: string) => `${btoa(JSON.stringify({ actor, operationId, context: { sourceWorkspaceId: 'source' } }))}.signature`
    const original = { message: 'original intent', systemAction: 'resolve_conflicts', resolutionContextToken: token(crypto.randomUUID()) }
    const send = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue({ ok: true })
    await expect(userSubmission('message:original', original, send)).rejects.toThrow('lost')
    vi.resetModules()
    const recovered = await import('../user-submission')
    const pending = recovered.pendingConflictSubmission(actor, 'source')!
    expect(pending).toMatchObject({ token: original.resolutionContextToken, receiverSessionId: 'original' })
    await expect(recovered.userSubmission('message:original', { ...original, resolutionContextToken: token(crypto.randomUUID()) }, send)).rejects.toThrow('original conflict submission')
    await expect(recovered.userSubmission('message:other-session', original, send)).rejects.toThrow('original conflict submission')
    expect(send).toHaveBeenCalledTimes(1)
    await recovered.userSubmission('message:original', original, send)
    expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0])
  })

  it('does not invent a new UUID when a pre-atomic client retained an ID but lost its original body', async () => {
    const key = `message:${crypto.randomUUID()}`; const id = crypto.randomUUID()
    const old = { message: 'legacy conflict', systemAction: 'resolve_conflicts' }
    sessionStorage.setItem(`tower:user-submission:${key}:${JSON.stringify(old)}`, id)
    const send = vi.fn()
    await expect(userSubmission(key, { ...old, resolutionContextToken: `${btoa(JSON.stringify({ actor: 'owner', operationId: crypto.randomUUID(), context: {} }))}.new` }, send)).rejects.toThrow('unavailable or damaged')
    expect(send).not.toHaveBeenCalled(); expect(sessionStorage.getItem(`tower:user-submission:${key}:${JSON.stringify(old)}`)).toBe(id)
  })

  it.each([true, false])('retries a lost workspace/session response with stable creation IDs (native UUID=%s)', async nativeUuid => {
    const task = crypto.randomUUID(); const input = { providerId: 'provider', prompt: 'original', workspaceKind: 'MAIN_DIRECTORY' }
    if (!nativeUuid) vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    const createWorkspace = vi.fn().mockRejectedValueOnce(new Error('lost workspace response')).mockResolvedValue({ id: 'workspace' })
    const startSession = vi.fn().mockRejectedValueOnce(new Error('lost start response')).mockResolvedValue({})
    const steps = { createWorkspace, startSession }
    await expect(taskStartSubmission(task, input, steps)).rejects.toThrow('lost workspace')
    expect(createWorkspace.mock.calls[0][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    api.post.mockRejectedValueOnce(new Error('lost session response')).mockResolvedValue({ id: 'session' })
    await expect(taskStartSubmission(task, input, steps)).rejects.toThrow('lost session')
    expect(createWorkspace.mock.calls[0][0]).toBe(createWorkspace.mock.calls[1][0])
    await expect(taskStartSubmission(task, input, steps)).rejects.toThrow('lost start')
    await taskStartSubmission(task, input, steps)
    expect(createWorkspace).toHaveBeenCalledTimes(2)
    expect(api.post.mock.calls[0][1].clientSubmissionId).toBe(api.post.mock.calls[1][1].clientSubmissionId)
    expect(startSession.mock.calls).toEqual([['session'], ['session']])
  })

  it('keeps workspace modes in the creation intent', async () => {
    const createWorkspace = vi.fn().mockRejectedValue(new Error('lost'))
    const task = crypto.randomUUID()
    for (const workspaceKind of ['MAIN_DIRECTORY', 'WORKTREE']) await expect(taskStartSubmission(task, { providerId: 'p', prompt: 'same', workspaceKind }, { createWorkspace, startSession: vi.fn() })).rejects.toThrow()
    expect(createWorkspace.mock.calls[0][0]).not.toBe(createWorkspace.mock.calls[1][0])
  })

  it('immediately caches pending 202 state and rejects an older REST revision after an action', () => {
    const client = new QueryClient()
    cacheDelivery(client, operation('DELIVERY_UNKNOWN', 4))
    const previous = client.getQueryData<Parameters<typeof mergeDeliveryPages>[1]>(['message-deliveries', 'session', 'pending'])!
    const merged = mergeDeliveryPages(previous, { pages: [{ items: [operation('ACCEPTED', 2)], nextCursor: null }], pageParams: [''] })
    expect(merged.pages[0].items[0].state).toBe('DELIVERY_UNKNOWN')
    cacheDelivery(client, operation('CANCELLED', 5))
    expect(client.getQueryData<typeof previous>(['message-deliveries', 'session', 'pending'])!.pages[0].items[0].revision).toBe(5)
    client.clear()
  })

  it('promotes a sent receipt into history before removing its pending projection', () => {
    const client = new QueryClient()
    cacheDelivery(client, operation('WAITING_TRANSLATION', 1))
    cacheDelivery(client, operation('SENT', 4))
    expect(client.getQueryData<Parameters<typeof mergeDeliveryPages>[1]>(['message-deliveries', 'session', 'sent'])!.pages[0].items[0]).toMatchObject({ id: 'delivery', state: 'SENT', revision: 4 })
    client.clear()
  })

  it('a Conversation 202 is restored through its destination, never cached as a Conversation entity', async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const container = document.createElement('div'); const root = createRoot(container)
    let create!: ReturnType<typeof useCreateConversation>['mutateAsync']
    function Probe({ ready }: { ready: (value: typeof create) => void }) {
      const { mutateAsync } = useCreateConversation()
      useEffect(() => { ready(mutateAsync) }, [ready, mutateAsync])
      return null
    }
    const delivery = operation()
    const response: MessageDeliverySubmission = { operationId: delivery.id, state: delivery.state, destination: delivery.destination, destinationId: 'conversation', sessionId: 'session', delivery }
    api.post.mockResolvedValue(response)
    api.get.mockResolvedValue({ id: 'conversation', sessionId: 'session', title: 'User original' })
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><Probe ready={value => { create = value }} /></QueryClientProvider>))
      await act(async () => { await create({ prompt: 'User original', providerId: 'provider' }) })
      expect(client.getQueryData(queryKeys.conversations.detail('conversation'))).toEqual({ id: 'conversation', sessionId: 'session', title: 'User original' })
      expect(client.getQueryData<{ pages: Array<{ items: MessageDelivery[] }> }>(['message-deliveries', 'session', 'pending'])!.pages[0].items[0].state).toBe('WAITING_TRANSLATION')
    } finally { await act(async () => root.unmount()); client.clear() }
  })
})
