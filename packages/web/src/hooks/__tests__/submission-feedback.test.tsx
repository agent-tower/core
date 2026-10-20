// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentType, RuntimeType, isSessionMessageDelivery } from '@agent-tower/shared'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import type { Conversation, MessageDelivery, MessageDeliverySubmission, TeamTaskInputSummary } from '@agent-tower/shared'
import { AgentSessionPanel } from '@/components/agent/AgentSessionPanel'
import { TaskDetail } from '@/components/task/TaskDetail'
import { MobileTaskDetail } from '@/components/mobile/MobileTaskDetail'
import type { UITaskDetailData } from '@/components/task/types'
import { LogStream } from '@/components/agent/LogStream'
import { MessageDeliveryFeedback } from '@/components/agent/MessageDeliveryStatus'
import { OutgoingSubmissionBubble } from '@/components/agent/OutgoingSubmissionBubble'
import { TeamInitialDeliveryStatus } from '@/components/team/TeamInitialDeliveryStatus'
import { TeamRoomDeliveryStatus } from '@/components/team/TeamRoomDeliveryStatus'
import { useStartSession, useSendMessage } from '../use-sessions'
import { useCreateConversation, useSendConversationMessage } from '../use-conversations'
import { useCreateTaskTeamRun } from '../use-team-run'
import { useOutgoingSubmissions } from '../outgoing-submissions'

vi.mock('use-stick-to-bottom', async () => {
  const React = await import('react')
  return { useStickToBottom: () => ({ scrollRef: React.useRef(null), contentRef: React.useRef(null), isAtBottom: true, scrollToBottom: vi.fn(), stopScroll: vi.fn() }) }
})
vi.mock('@/lib/socket/hooks/useNormalizedLogs', () => ({ useNormalizedLogs: () => ({ isConnected: false, isLoadingSnapshot: false, isOutputActive: false, lastExitAt: null, logs: [], entries: [], attach: vi.fn() }) }))
vi.mock('@/lib/socket/hooks/useWorkspaceSetupProgress', () => ({ useWorkspaceSetupProgress: () => undefined }))
const providerFixture = vi.hoisted(() => ({ rows: [{ provider: { id: 'provider', name: 'Test provider', agentType: 'CODEX', runtimeType: 'CLI', env: {}, config: {}, isDefault: true }, availability: { type: 'INSTALLATION_FOUND' } }] }))
vi.mock('@/hooks/use-providers', () => ({ useProviders: () => ({ data: providerFixture.rows }) }))
vi.mock('@/hooks/use-tasks', async original => ({ ...await original<typeof import('@/hooks/use-tasks')>(), useTaskBody: () => ({ data: { title: 'Task', description: '' }, isLoading: false }) }))
vi.mock('@/hooks/use-workspaces', async original => ({ ...await original<typeof import('@/hooks/use-workspaces')>(), useWorkspaces: () => ({ data: [{ id: 'workspace', taskId: 'task', status: 'ACTIVE', kind: 'MAIN_DIRECTORY', sessions: [{ id: 'session', status: 'RUNNING', agentType: 'CODEX', providerId: 'provider', workspaceId: 'workspace', createdAt: new Date().toISOString() }] }], isLoading: false }), useGitStatus: () => ({ data: undefined }) }))
vi.mock('@/hooks/use-git', async original => ({ ...await original<typeof import('@/hooks/use-git')>(), useGitChanges: () => ({ data: undefined }) }))
vi.mock('@/components/workspace/WorkspacePanel', () => ({ WorkspacePanel: () => null }))
vi.mock('@/lib/socket/manager', () => ({ socketManager: { connect: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: false }) } }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (text: string) => text }) }))
vi.mock('streamdown', () => ({ Streamdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('@streamdown/mermaid', () => ({ mermaid: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Entry = 'task-first' | 'task-followup' | 'conversation-first' | 'conversation-followup'
function delivery(origin: MessageDelivery['origin'] = 'TASK_FOLLOWUP'): MessageDelivery {
  const common = {
    id: 'operation', clientSubmissionId: 'submission', channelKey: 'channel', sequence: 1,
    originalText: 'Submitted original', attachmentIds: ['attachment'], state: 'READY' as const,
    sentMode: 'ORIGINAL' as const, acceptedText: 'Submitted original', actualSentText: null, sentAt: null,
    acceptedDestinationId: null, lastError: null, revision: 1, createdAt: new Date().toISOString(),
  }
  if (origin === 'TEAM_INITIAL') return { ...common, origin, destination: { kind: 'TEAM_ROOM_PENDING', taskId: 'task', plannedTeamRunId: 'team' } }
  if (origin === 'TEAM_USER') return { ...common, origin, destination: { kind: 'TEAM_ROOM', taskId: 'task', teamRunId: 'team' } }
  if (origin === 'CONVERSATION') return { ...common, origin, sessionId: 'session', conversationId: 'conversation', destination: { kind: 'CONVERSATION', sessionId: 'session', conversationId: 'conversation' } }
  return { ...common, origin, sessionId: 'session', conversationId: null, destination: { kind: 'SESSION', sessionId: 'session' } }
}
function response(item: MessageDelivery) {
  const common = { operationId: item.id, state: item.state, delivery: item, destination: item.destination }
  if (isSessionMessageDelivery(item)) return { ...common, destinationId: item.conversationId ?? item.sessionId, sessionId: item.sessionId } as MessageDeliverySubmission
  return (item.destination.kind === 'TEAM_ROOM_PENDING' ? common : { ...common, destinationId: item.destination.teamRunId }) as MessageDeliverySubmission
}
const conversation = { id: 'conversation', sessionId: 'session' } as Conversation
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
function Submission({ entry, sessionId = 'session' }: { entry: Entry; sessionId?: string }) {
  const start = useStartSession()
  const send = useSendMessage()
  const create = useCreateConversation()
  const followup = useSendConversationMessage()
  const [created, setCreated] = useState(false)
  const outgoing = useOutgoingSubmissions('new-conversation')
  const pending = start.isPending || send.isPending || create.isPending || followup.isPending
  const submit = async () => {
    try {
      const input = { message: 'Submitted original', attachmentIds: ['attachment'] }
      if (entry === 'task-first') await start.mutateAsync(sessionId)
      if (entry === 'task-followup') await send.mutateAsync({ id: sessionId, ...input })
      if (entry === 'conversation-first') { await create.mutateAsync({ prompt: input.message, providerId: 'provider', attachmentIds: input.attachmentIds }); setCreated(true) }
      if (entry === 'conversation-followup') await followup.mutateAsync({ id: 'conversation', sessionId, ...input })
    } catch { /* Recovery belongs to the immutable outgoing bubble. */ }
  }
  return <>
    <button disabled={pending} aria-busy={pending} onClick={() => void submit()}>Submit</button>
    {entry === 'conversation-first' && !created
      ? outgoing.map(item => <OutgoingSubmissionBubble key={item.id} item={item} />)
      : <LogStream sessionId={sessionId} logs={[]} />}
  </>
}
function TeamStart() {
  const create = useCreateTaskTeamRun()
  return <><button disabled={create.isPending} aria-busy={create.isPending} onClick={() => create.mutate({ taskId: 'task', mode: 'AUTO' })}>Create team</button><TeamInitialDeliveryStatus taskId="task" /></>
}

let client: QueryClient
let root: Root
let host: HTMLDivElement
let enabled: boolean
let stored: MessageDelivery | undefined
let inputs: TeamTaskInputSummary[]
let submit: ReturnType<typeof deferred<Response>>
let requests: Array<{ path: string; method: string; body: Record<string, unknown> }>
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }
async function mount(element: React.ReactNode) {
  await act(async () => root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>))
  await flush()
}
async function refresh(item: MessageDelivery) {
  stored = item
  await act(async () => { await client.invalidateQueries({ queryKey: ['message-deliveries'] }) })
  await flush()
}
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find(item => item.textContent === text)
  if (!found) throw new Error(`Missing button ${text}: ${host.textContent}`)
  return found
}
function expectQuiet() {
  expect(host.querySelector('[data-delivery-state]')).toBeNull()
  for (const text of ['Waiting to send', 'Send original', 'Retry translation', 'Cancel']) expect(host.textContent).not.toContain(text)
}
beforeEach(() => {
  enabled = false; stored = undefined; inputs = []; requests = []; submit = deferred<Response>()
  sessionStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url, 'http://test')
    const path = parsed.pathname.replace(/^\/api/, '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    requests.push({ path, method, body })
    if (method === 'POST') return submit.promise
    if (path === '/translation-settings') return json({ enabled, sendTargetLanguage: 'English', displayTargetLanguage: 'Chinese' })
    if (path === '/attachments/metadata') return json([{ id: 'attachment', originalName: 'evidence.txt', url: '/api/attachments/attachment/file' }])
    if (path === '/message-deliveries') {
      const scopeMatches = stored && parsed.searchParams.get('scopeId') === (isSessionMessageDelivery(stored) ? stored.sessionId : stored.destination.taskId)
      const matches = scopeMatches && stored && stored.state !== 'CANCELLED' && (parsed.searchParams.get('filter') === 'sent') === (stored.state === 'SENT')
      return json({ items: matches ? [stored] : [], nextCursor: null })
    }
    if (path === '/message-deliveries/operation') return json(stored)
    if (path === '/sessions/session/runtime') return json({ sessionId: 'session', turnState: 'RUNNING', pendingPermissions: [] })
    if (path === '/tasks/task/team-run') return json(null)
    if (path.endsWith('/slash-commands') || path.endsWith('/skills')) return json([])
    if (path === '/conversations/conversation') return json(conversation)
    if (path === '/team-runs/team/task-inputs') return json({ items: inputs, nextCursor: null })
    throw new Error(`Unexpected test request: ${method} ${path}`)
  }))
})
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove(); sessionStorage.clear(); vi.unstubAllGlobals()
})

describe('ordinary submission feedback through production hooks, HTTP and query refresh', () => {
  it.each(['task-first', 'task-followup', 'conversation-first', 'conversation-followup'] as const)('%s stays quiet before acceptance and through READY / DISPATCHING / SENT', async entry => {
    await mount(<Submission entry={entry} />)
    await act(async () => button('Submit').click())
    await flush()
    expect(button('Submit').disabled).toBe(true)
    if (entry !== 'task-first') {
      expect(host.textContent).toContain('Submitted original')
      expect(host.textContent).toContain('evidence.txt')
      expect(host.querySelector('[data-submission-id]')).not.toBeNull()
    }
    expectQuiet()
    // The HTTP response remains unresolved while a second render is observed.
    await flush(); expectQuiet()
    const request = requests.find(item => item.method === 'POST')!
    stored = { ...delivery(entry.startsWith('conversation') ? 'CONVERSATION' : entry === 'task-first' ? 'TASK_INITIAL' : 'TASK_FOLLOWUP'), clientSubmissionId: String(request.body.clientSubmissionId) }
    await act(async () => submit.resolve(json(response(stored!), 202)))
    await flush()
    expect(button('Submit').disabled).toBe(false)
    expect(host.querySelector('[data-submission-id]')).toBeNull()
    expect(host.textContent).toContain('Submitted original'); expectQuiet()
    await refresh({ ...stored!, state: 'DISPATCHING', revision: 2 }); expectQuiet()
    await refresh({ ...stored!, state: 'SENT', actualSentText: stored!.originalText, revision: 3 })
    expectQuiet(); expect(host.textContent).toContain('Submitted original')
    expect(requests.some(item => item.path === '/message-deliveries/operation')).toBe(true)
    // Restored and switched sessions must use the same per-operation facts.
    await mount(<LogStream sessionId="another-session" logs={[]} />)
    expect(host.textContent).not.toContain('Submitted original')
    await mount(<LogStream sessionId="session" logs={[]} />)
    expect(host.textContent).toContain('Submitted original')
    expectQuiet()
    expect(requests.filter(item => item.method === 'POST')).toHaveLength(1)
  })

  it.each(['desktop-task', 'mobile-task', 'conversation'] as const)('keeps %s send-button feedback after clearing an active-session draft', async surface => {
    const task: UITaskDetailData = { id: 'task', projectId: 'project', title: 'Task', description: '', projectName: 'Project', projectColor: 'text-blue-500', status: 'Running', branch: '', mainBranch: 'main', isGitRepo: false }
    function ConversationPanel() {
      const send = useSendConversationMessage()
      return <AgentSessionPanel sessionId="session" sessionStatus="RUNNING" agentType={AgentType.CODEX} runtimeType={RuntimeType.CLI} providerId="provider" providers={providerFixture.rows as ProviderWithAvailability[]} isSending={send.isPending} onSend={async input => { await send.mutateAsync({ id: 'conversation', sessionId: 'session', ...input }) }} onStop={async () => {}} />
    }
    await mount(surface === 'desktop-task' ? <TaskDetail task={task} /> : surface === 'mobile-task' ? <MobileTaskDetail task={task} onBack={() => {}} /> : <ConversationPanel />)
    const textarea = host.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Submitted original')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click() }); await flush()
    expect(textarea.value).toBe('')
    expect(host.querySelector('button[aria-busy="true"] .animate-spin')).not.toBeNull()
    expect(host.querySelector('button[aria-label="Stop"]')).toBeNull()
    expectQuiet()
    const request = requests.find(item => item.method === 'POST')!
    stored = { ...delivery(surface === 'conversation' ? 'CONVERSATION' : 'TASK_FOLLOWUP'), clientSubmissionId: String(request.body.clientSubmissionId) }
    await act(async () => submit.resolve(json(response(stored!), 202))); await flush(); expectQuiet()
    await refresh({ ...stored!, state: 'DISPATCHING', revision: 2 }); expectQuiet()
    await refresh({ ...stored!, state: 'SENT', revision: 3 }); expectQuiet()
  })

  it('preserves real translation progress and original fallback, including a default ORIGINAL mode with no accepted text', async () => {
    enabled = true
    await mount(<Submission entry="task-followup" />)
    await act(async () => button('Submit').click()); await flush(); expectQuiet()
    const request = requests.find(item => item.method === 'POST')!
    stored = { ...delivery(), clientSubmissionId: String(request.body.clientSubmissionId), state: 'WAITING_TRANSLATION', acceptedText: null }
    await act(async () => submit.resolve(json(response(stored!), 202))); await flush()
    expect(host.textContent).toContain('Waiting for translation')
    expect(button('Send original')).toBeDefined()
    await refresh({ ...stored!, state: 'READY', sentMode: 'TRANSLATED', acceptedText: 'Translated text', revision: 2 })
    expect(host.textContent).toContain('Waiting to send')
    await refresh({ ...stored!, state: 'SENT', actualSentText: 'Translated text', revision: 3 })
    enabled = false
    await act(async () => { await client.invalidateQueries({ queryKey: ['translation-settings'] }) }); await flush()
    expect(host.querySelector('[aria-haspopup="dialog"]')).not.toBeNull()
  })

  it('recovers unknown HTTP acceptance from the stored original UUID and attachment snapshot', async () => {
    await mount(<Submission entry="task-followup" />)
    await act(async () => button('Submit').click()); await flush()
    const original = requests.find(item => item.method === 'POST')!
    await act(async () => submit.reject(new Error('response lost'))); await flush()
    expect(host.textContent).toContain('Acceptance unknown; check or retry the same submission.')
    expect(host.textContent).toContain('evidence.txt')
    await mount(<></>); client.clear()
    await mount(<Submission entry="task-followup" />)
    submit = deferred<Response>()
    await act(async () => button('Retry original submission').click()); await flush()
    expect(requests.filter(item => item.method === 'POST')[1].body).toEqual(original.body)
    stored = { ...delivery(), clientSubmissionId: String(original.body.clientSubmissionId) }
    await act(async () => submit.resolve(json(response(stored!), 202))); await flush()
    expectQuiet(); expect(host.textContent).toContain('evidence.txt')
  })

  it.each([false, true])('TEAM_INITIAL handles direct success or pending recovery (pending=%s)', async pending => {
    await mount(<TeamStart />)
    await act(async () => button('Create team').click()); await flush()
    expect(button('Create team').disabled).toBe(true); expectQuiet()
    if (pending) {
      stored = delivery('TEAM_INITIAL')
      await act(async () => submit.resolve(json(response(stored!), 202))); await flush()
      expect(host.textContent).toContain('Submitted original'); expectQuiet()
      await mount(<></>); client.clear(); await mount(<TeamInitialDeliveryStatus taskId="task" />)
      expect(host.textContent).toContain('Submitted original'); expectQuiet()
      await refresh({ ...stored!, state: 'WAITING_PREDECESSOR', revision: 2 })
      expect(host.textContent).toContain('Queued, not sent'); expect(button('Cancel')).toBeDefined()
      expect(host.textContent).not.toContain('Send original')
      await refresh({ ...stored!, state: 'DISPATCHING', revision: 3 }); expectQuiet()
      await refresh({ ...stored!, state: 'SENT', revision: 4 }); expectQuiet()
    } else {
      await act(async () => submit.resolve(json({ id: 'team', taskId: 'task', messages: [], workRequests: [], invocations: [] }, 201))); await flush()
      expectQuiet(); expect(host.querySelector('[data-operation-id]')).toBeNull()
    }
  })
})

describe('durable feedback and executable recovery', () => {
  it.each(['WAITING_PREDECESSOR', 'ACCEPTED', 'WAITING_TASK_INPUT', 'DELIVERY_FAILED', 'PAUSED_DISABLED', 'DELIVERY_UNKNOWN'] as const)('keeps generic %s feedback for original sends without translation actions', async state => {
    stored = { ...delivery(), state }
    await mount(<LogStream sessionId="session" logs={[]} />)
    expect(host.querySelector('[data-delivery-state]')?.getAttribute('data-delivery-state')).toBe(state)
    expect(host.textContent).not.toContain('Send original')
    expect(host.textContent).not.toContain('Retry translation')
    const action = state === 'DELIVERY_UNKNOWN' ? 'Confirmed not sent: retry' : ['DELIVERY_FAILED', 'PAUSED_DISABLED'].includes(state) ? 'Retry delivery' : 'Cancel'
    await act(async () => button(action).click()); await flush()
    const request = requests.find(item => item.method === 'POST')!
    expect(request.path).toBe('/message-deliveries/operation/actions')
    expect(request.body).toMatchObject({ expectedRevision: 1, action: state === 'DELIVERY_UNKNOWN' ? 'confirm_not_sent' : action === 'Retry delivery' ? 'retry_delivery' : 'cancel' })
    expect(typeof request.body.actionId).toBe('string')
    stored = { ...stored!, state: action === 'Cancel' ? 'CANCELLED' : 'READY', revision: 2 }
    await act(async () => submit.resolve(json(response(stored!)))); await flush()
    if (action !== 'Cancel') expectQuiet()
  })

  it.each([false, true])('only offers retry translation when enabled=%s, retaining paused original fallback', async active => {
    enabled = active
    await mount(<MessageDeliveryFeedback delivery={{ ...delivery(), state: 'PAUSED_DISABLED', sentMode: null, acceptedText: null }} />)
    expect(host.textContent).toContain('Sending paused')
    expect(host.textContent?.includes('Retry translation')).toBe(active)
    expect(button('Send original')).toBeDefined()
    expect(button('Cancel')).toBeDefined()
  })

  it.each([false, true])('also gates the shared team task-input retry when enabled=%s', async active => {
    enabled = active
    inputs = [{ id: 'input', teamRunId: 'team', taskId: 'task', taskSourceHash: 'hash', state: 'PENDING', revision: 1, sentMode: null, acceptedAt: null, translationState: 'PAUSED_DISABLED', errorCode: null, consumerCount: 1 }]
    await mount(<TeamRoomDeliveryStatus taskId="task" teamRunId="team" />)
    expect(host.textContent?.includes('Retry translation')).toBe(active)
    expect(button('Send original')).toBeDefined()
  })
})
