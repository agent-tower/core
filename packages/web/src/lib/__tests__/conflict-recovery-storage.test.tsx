// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConflictOp } from '@agent-tower/shared'
import type { ConflictDetails } from '@/components/workspace/GitOperationsDialog'
import { apiClient } from '../api-client'
import { useConflictRecovery } from '@/hooks/use-conflict-recovery'
import { ConflictRecoveryNotice } from '@/components/workspace/ConflictRecoveryNotice'
import { ResolveConflictsDialog } from '@/components/workspace/ResolveConflictsDialog'
import { conflictRecoveryStorageUnavailable, readConflictRecovery, saveConflictRecovery } from '../conflict-recovery-storage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const send = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-sessions', () => ({ useSendMessage: () => ({ mutate: send, isPending: false }) }))
vi.mock('@/hooks/use-team-run', () => ({ usePostRoomMessage: () => ({ mutate: vi.fn(), isPending: false }) }))
vi.mock('@/hooks/use-workspaces', () => ({ useOpenInEditor: () => ({ mutate: vi.fn() }) }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (source: string) => source }) }))
vi.mock('@/components/ui/modal', () => ({ Modal: ({ children, action, onClose }: { children: React.ReactNode; action: React.ReactNode; onClose: () => void }) => <div>{children}{action}<button onClick={onClose}>close dialog</button></div> }))
function details(actor = crypto.randomUUID()): ConflictDetails {
  const body = { actor, operationId: crypto.randomUUID(), context: { sourceWorkspaceId: 'source' }, recovery: { expiresAt: Date.now() + 86400000 } }
  return { resolutionContextToken: `${btoa(JSON.stringify(body))}.signature`, conflictOp: ConflictOp.MERGE, conflictedFiles: ['original.ts'],
    sourceWorkspaceId: 'source', sourceBranch: 'feature/original', targetBranch: 'main', sourceWorktreePath: '/source', targetWorktreePath: '/actual-target', mergeStrategy: 'squash', mergeAborted: false }
}
const button = (node: HTMLElement, text: string) => [...node.querySelectorAll('button')].find(value => value.textContent === text)!
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); send.mockReset() })

describe('same-tab conflict evidence recovery', () => {
  it.each(['desktop', 'mobile'])('saves a %s 409 before first send; refreshed and reopened entry only reads, never auto-sends', async () => {
    const actor = crypto.randomUUID(); const original = details(actor)
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => String(url).endsWith('/conflict-recovery-identity')
      ? new Response(JSON.stringify({ actor }), { status: 200 })
      : new Response(JSON.stringify({ ...original, code: 'MERGE_CONFLICT' }), { status: init?.method === 'POST' ? 409 : 200 }))
    await expect(apiClient.post('/workspaces/source/merge', {})).rejects.toMatchObject({ status: 409 })
    expect(readConflictRecovery(actor)[0].details).toMatchObject(original)
    expect(sessionStorage.length).toBe(1); expect(send).not.toHaveBeenCalled()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); const node = document.createElement('div'); let root = createRoot(node)
    function Entry() {
      const [draft, setDraft] = useState<ConflictDetails>()
      const recovery = useConflictRecovery(['source'])
      return <><ConflictRecoveryNotice recovery={recovery} onRecover={setDraft} />{draft && <ResolveConflictsDialog {...draft} sourceBranch={draft.sourceBranch!} targetBranch={draft.targetBranch!} open onOpenChange={open => { if (!open) setDraft(undefined) }} workspaceId="source" sessions={[]} currentSessionId="source-session" />}</>
    }
    const mount = async () => {
      await act(async () => { root.render(<QueryClientProvider client={client}><Entry /></QueryClientProvider>); await new Promise(r => setTimeout(r, 10)) })
      await act(async () => { await new Promise(r => setTimeout(r, 10)) })
    }
    try {
      await mount(); expect(node.textContent).toContain('恢复上次冲突资料')
      await act(async () => button(node, '恢复上次冲突资料').click())
      expect(node.textContent).toContain('original.ts'); expect(node.textContent).toContain('/actual-target')
      await act(async () => button(node, 'close dialog').click())
      await act(async () => button(node, '恢复上次冲突资料').click())
      expect(send).not.toHaveBeenCalled()
      // Simulate a refreshed React tree; storage stays in the same tab.
      await act(async () => root.unmount()); root = createRoot(node); await mount()
      expect(node.textContent).toContain('恢复上次冲突资料'); expect(send).not.toHaveBeenCalled()
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    } finally { await act(async () => root.unmount()); client.clear() }
  })

  it('isolates identity, retains expired evidence, and exposes storage failure without promising refresh recovery', () => {
    const actor = crypto.randomUUID(); const original = details(actor)
    const token = JSON.parse(atob(original.resolutionContextToken!.split('.')[0])); token.recovery.expiresAt = Date.now() - 1
    original.resolutionContextToken = `${btoa(JSON.stringify(token))}.signature`
    saveConflictRecovery(original)
    expect(readConflictRecovery('a-different-browser')).toEqual([])
    expect(readConflictRecovery(actor)[0].expiresAt).toBeLessThan(Date.now())
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new Error('storage denied') })
    const unavailable = details(actor); saveConflictRecovery(unavailable)
    expect(conflictRecoveryStorageUnavailable()).toBe(true)
    expect(readConflictRecovery(actor).some(draft => draft.details.resolutionContextToken === unavailable.resolutionContextToken)).toBe(true)
  })
});
