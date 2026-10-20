import { apiClient } from '@/lib/api-client'

type PendingStart = { creationId: string; workspace?: { id: string }; session?: { id: string } }
const pending = new Map<string, PendingStart>()
/** One explicit start retains destination identities across a failed create/start response. */
export async function taskStartSubmission(
  taskId: string,
  input: { providerId: string; prompt: string; retryTask?: boolean; workspaceKind?: string },
  steps: {
    createWorkspace(clientSubmissionId: string): Promise<{ id: string }>
    startSession(id: string): Promise<unknown>
    onStep?(step: 'creating-workspace' | 'creating-session' | 'starting-session'): void
  },
) {
  const key = `tower:task-start:${taskId}:${JSON.stringify(input)}`
  let state = pending.get(key)
  if (!state) { try { const saved = sessionStorage.getItem(key); if (saved) state = JSON.parse(saved) } catch { /* Fall back to the current page. */ } }
  state ??= { creationId: crypto.randomUUID() }
  pending.set(key, state)
  const save = () => { try { sessionStorage.setItem(key, JSON.stringify(state)) } catch { /* Identity remains in memory. */ } }
  save()
  if (!state.workspace) { steps.onStep?.('creating-workspace'); state.workspace = await steps.createWorkspace(state.creationId); save() }
  if (!state.session) {
    steps.onStep?.('creating-session')
    state.session = await apiClient.post<{ id: string }>(`/workspaces/${state.workspace.id}/sessions`, { providerId: input.providerId, prompt: input.prompt, retryTask: input.retryTask, clientSubmissionId: state.creationId })
    save()
  }
  steps.onStep?.('starting-session')
  await steps.startSession(state.session.id)
  pending.delete(key)
  try { sessionStorage.removeItem(key) } catch { /* The operation is durable on the server. */ }
  return { workspace: state.workspace, session: state.session }
}
