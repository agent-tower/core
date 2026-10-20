// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConflictOp } from '@agent-tower/shared'
import { ConflictRecoveryNotice } from '@/components/workspace/ConflictRecoveryNotice'
import { ResolveConflictsDialog } from '@/components/workspace/ResolveConflictsDialog'
import type { ConflictDetails } from '@/components/workspace/GitOperationsDialog'
import { readConflictRecovery, removeConflictRecovery, saveConflictRecovery } from '@/lib/conflict-recovery-storage'
import { useConflictRecovery } from '../use-conflict-recovery'
import { useLogoutAccessAuth } from '../use-access-auth'
import { userSubmission } from '../user-submission'
import { queryKeys } from '../query-keys'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const send = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-sessions', () => ({ useSendMessage: () => ({ mutate: send, isPending: false }) }))
vi.mock('@/hooks/use-team-run', () => ({ usePostRoomMessage: () => ({ mutate: vi.fn(), isPending: false }) }))
vi.mock('@/hooks/use-workspaces', () => ({ useOpenInEditor: () => ({ mutate: vi.fn() }) }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (text: string) => text }) }))
vi.mock('@/components/ui/modal', () => ({ Modal: ({ children, action }: { children: React.ReactNode; action: React.ReactNode }) => <div role="dialog">{children}{action}</div> }))
const click = (node: HTMLElement, label: string) => [...node.querySelectorAll('button')].find(button => button.textContent === label)!.click()
const tick = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) }) }
function details(actor: string, file = 'original.ts'): ConflictDetails {
  const context = { sourceWorkspaceId: 'source', targetWorkspaceId: 'target', sourceWorktreePath: '/source', targetWorktreePath: '/original-target', sourceBranch: 'original', targetBranch: 'main', conflictOp: ConflictOp.MERGE, conflictedFiles: [file], mergeStrategy: 'squash' }
  return { ...context, mergeStrategy: 'squash', resolutionContextToken: `${btoa(JSON.stringify({ actor, operationId: crypto.randomUUID(), context }))}.signature` }
}
function Entry({ observed }: { observed: ConflictDetails }) {
  const recovery = useConflictRecovery(['source'])
  const logout = useLogoutAccessAuth()
  const draft = recovery.pendingConflictDetails
  return <><ConflictRecoveryNotice recovery={recovery} onRecover={recovery.openDialog} />
    <button onClick={() => recovery.openDialog(observed)}>ordinary banner</button>
    <button onClick={() => logout.mutate()}>logout</button>
    {draft && <ResolveConflictsDialog {...draft} sourceBranch={draft.sourceBranch!} targetBranch={draft.targetBranch!}
      open onOpenChange={open => { if (!open) recovery.closeDialog() }} workspaceId="source" currentSessionId="new-current-session" sessions={[]} />}
  </>
}
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); send.mockReset() })

describe('conflict recovery identity and original request lifecycle', () => {
  it.each([false, true])('recovers the original unknown request from a new banner (display draft cleared: %s)', async cleared => {
    const actor = crypto.randomUUID(); const original = details(actor); const observed = details(actor, 'new-observation.ts')
    // Simulate a pre-fix ordinary banner draft missing every source field.
    const incomplete = { resolutionContextToken: original.resolutionContextToken, conflictOp: ConflictOp.MERGE, conflictedFiles: ['original.ts'] }
    const draft = saveConflictRecovery(incomplete, 'original-session')!
    sessionStorage.setItem(`tower:conflict-recovery:v1:${actor}:${draft.operationId}`, JSON.stringify({ ...draft, details: incomplete }))
    expect(readConflictRecovery(actor)[0].details).toMatchObject({ sourceWorkspaceId: 'source', targetWorktreePath: '/original-target' })
    const body = { message: 'original frozen body', systemAction: 'resolve_conflicts', resolutionContextToken: original.resolutionContextToken }
    await expect(userSubmission('message:original-session', body, async () => { throw new Error('lost') })).rejects.toThrow('lost')
    if (cleared) removeConflictRecovery(original.resolutionContextToken)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ actor })))
    const client = new QueryClient(); const node = document.createElement('div'); const root = createRoot(node)
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><Entry observed={observed} /></QueryClientProvider>)); await tick()
      act(() => click(node, 'ordinary banner'))
      expect(node.querySelector('[role="dialog"]')?.textContent).toContain('original.ts')
      expect(node.querySelector('[role="dialog"]')?.textContent).not.toContain('new-observation.ts')
      act(() => click(node, 'AI 辅助解决'))
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 'original-session', resolutionContextToken: original.resolutionContextToken }), expect.anything())
    } finally { act(() => root.unmount()); client.clear() }
  })

  it('hides cached evidence, closes its open dialog and ignores late renewal on identity refetch error and actor change', async () => {
    const actor = crypto.randomUUID(); const original = details(actor); saveConflictRecovery(original)
    let currentActor = actor; let fail = false; let finishRenewal!: (response: Response) => void
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).endsWith('/conflict-context')) return new Promise<Response>(resolve => { finishRenewal = resolve })
      if (fail) throw new Error('identity network failure')
      return new Response(JSON.stringify({ actor: currentActor }))
    })
    const client = new QueryClient(); const node = document.createElement('div'); const root = createRoot(node)
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><Entry observed={original} /></QueryClientProvider>)); await tick()
      act(() => click(node, '恢复上次冲突资料'))
      expect(node.querySelector('[role="dialog"]')).not.toBeNull()
      act(() => click(node, '只读核验当前冲突'))
      fail = true
      await act(async () => { await client.refetchQueries({ queryKey: queryKeys.accessAuth.conflictRecoveryIdentity }) }); await tick()
      expect(client.getQueryData(queryKeys.accessAuth.conflictRecoveryIdentity)).toEqual({ actor })
      expect(node.textContent).toContain('无法确认当前身份')
      expect(node.textContent).not.toContain('恢复上次冲突资料'); expect(node.querySelector('[role="dialog"]')).toBeNull()
      finishRenewal(new Response(JSON.stringify({ resolutionContextToken: details(actor, 'late-old.ts').resolutionContextToken }))); await tick()
      expect(readConflictRecovery(actor)).toHaveLength(1)
      currentActor = crypto.randomUUID(); fail = false
      await act(async () => { await client.refetchQueries({ queryKey: queryKeys.accessAuth.conflictRecoveryIdentity }) }); await tick()
      expect(node.textContent).not.toContain('恢复上次冲突资料'); expect(node.querySelector('[role="dialog"]')).toBeNull()
      currentActor = actor
      await act(async () => { await client.refetchQueries({ queryKey: queryKeys.accessAuth.conflictRecoveryIdentity }) }); await tick()
      expect(node.textContent).toContain('恢复上次冲突资料'); expect(node.querySelector('[role="dialog"]')).toBeNull()
      expect(send).not.toHaveBeenCalled()
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/conflict-context'))).toHaveLength(1)
    } finally { act(() => root.unmount()); client.clear() }
  })

  it('closes on logout and requires a fresh identity before exposing evidence', async () => {
    const actor = crypto.randomUUID(); const original = details(actor); saveConflictRecovery(original)
    let finishLogout!: (response: Response) => void; let changed = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).endsWith('/logout')) return new Promise<Response>(resolve => { finishLogout = resolve })
      return new Response(JSON.stringify({ actor: changed ? 'new-actor' : actor }))
    })
    const client = new QueryClient(); const node = document.createElement('div'); const root = createRoot(node)
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><Entry observed={original} /></QueryClientProvider>)); await tick()
      act(() => click(node, '恢复上次冲突资料')); expect(node.querySelector('[role="dialog"]')).not.toBeNull()
      act(() => click(node, 'logout')); await tick()
      expect(node.querySelector('[role="dialog"]')).toBeNull(); expect(node.textContent).not.toContain('恢复上次冲突资料')
      changed = true; finishLogout(new Response(JSON.stringify({ enabled: false, authenticated: false }))); await tick(); await tick()
      expect(client.getQueryData(queryKeys.accessAuth.conflictRecoveryIdentity)).toEqual({ actor: 'new-actor' })
      expect(node.querySelector('[role="dialog"]')).toBeNull(); expect(node.textContent).not.toContain('恢复上次冲突资料')
    } finally { act(() => root.unmount()); client.clear() }
  })

  it('cancels the old identity request and ignores its late success after logout verifies another actor', async () => {
    const actor = crypto.randomUUID(); const original = details(actor); saveConflictRecovery(original)
    let holdOldIdentity = false; let changed = false
    let finishOldIdentity!: (response: Response) => void; let oldSignal: AbortSignal | null | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/logout')) { changed = true; return new Response(JSON.stringify({ enabled: false, authenticated: true })) }
      if (holdOldIdentity && !changed) {
        oldSignal = init?.signal
        return new Promise<Response>(resolve => { finishOldIdentity = resolve })
      }
      return new Response(JSON.stringify({ actor: changed ? 'verified-new-actor' : actor }))
    })
    const client = new QueryClient(); const node = document.createElement('div'); const root = createRoot(node)
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><Entry observed={original} /></QueryClientProvider>)); await tick()
      holdOldIdentity = true
      act(() => { void client.refetchQueries({ queryKey: queryKeys.accessAuth.conflictRecoveryIdentity }) })
      expect(oldSignal?.aborted).toBe(false)
      act(() => click(node, 'logout')); await tick(); await tick()
      expect(oldSignal?.aborted).toBe(true)
      expect(client.getQueryData(queryKeys.accessAuth.conflictRecoveryIdentity)).toEqual({ actor: 'verified-new-actor' })
      finishOldIdentity(new Response(JSON.stringify({ actor }))); await tick()
      expect(client.getQueryData(queryKeys.accessAuth.conflictRecoveryIdentity)).toEqual({ actor: 'verified-new-actor' })
      expect(node.textContent).not.toContain('恢复上次冲突资料'); expect(node.querySelector('[role="dialog"]')).toBeNull()
    } finally { act(() => root.unmount()); client.clear() }
  })
})
