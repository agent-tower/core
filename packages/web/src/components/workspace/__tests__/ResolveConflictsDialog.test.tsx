// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ConflictOp } from '@agent-tower/shared'
import { ResolveConflictsDialog } from '../ResolveConflictsDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const send = vi.hoisted(() => vi.fn())
const readGit = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-client', () => ({ apiClient: { get: readGit, post: refresh } }))
vi.mock('@/hooks/use-sessions', () => ({ useSendMessage: () => ({ mutate: send, isPending: false }) }))
vi.mock('@/hooks/use-team-run', () => ({ usePostRoomMessage: () => ({ mutate: vi.fn(), isPending: false }) }))
vi.mock('@/hooks/use-workspaces', () => ({ useOpenInEditor: () => ({ mutate: vi.fn() }) }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (source: string) => source }) }))
vi.mock('@/components/ui/modal', () => ({ Modal: ({ children, action }: { children: ReactNode; action: ReactNode }) => <div>{children}{action}</div> }))

describe('AI conflict action admission', () => {
  it('round-trips the server capability when the selected Session and merge target are different workspaces', () => {
    const container = document.createElement('div'); const root = createRoot(container)
    try {
      act(() => root.render(<ResolveConflictsDialog open onOpenChange={() => {}} workspaceId="target" conflictOp={ConflictOp.MERGE} conflictedFiles={['app.ts']}
        sourceBranch="feature/change" targetBranch="main" targetWorktreePath="/target" sourceWorktreePath="/source" sourceWorkspaceId="source" targetWorkspaceId="target"
        mergeAborted mergeStrategy="squash" currentSessionId="source-session" sessions={[]} resolutionContextToken="signed-server-context" />))
      act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'AI 辅助解决')!.click())
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 'source-session', systemAction: 'resolve_conflicts', resolutionContextToken: 'signed-server-context',
        message: expect.stringContaining('git merge --squash --no-commit feature/change') }), expect.any(Object))
    } finally { act(() => root.unmount()); container.remove(); send.mockClear() }
  })
  it('keeps the dialog and original operation after rejection; checking an aborted scene only reads Git', async () => {
    const container = document.createElement('div'); const root = createRoot(container); const close = vi.fn()
    send.mockImplementation((_input, options) => options.onError(new Error('Not accepted: conflict context expired')))
    refresh.mockRejectedValue(new Error('确认 Git 状态后明确重新执行原操作'))
    try {
      act(() => root.render(<ResolveConflictsDialog open onOpenChange={close} workspaceId="target" conflictOp={ConflictOp.MERGE} conflictedFiles={['original.ts']}
        sourceBranch="feature/original" targetBranch="main" sourceWorkspaceId="source" targetWorktreePath="/original-target" mergeAborted mergeStrategy="squash" currentSessionId="source-session" sessions={[]} resolutionContextToken="old-signature" />))
      act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'AI 辅助解决')!.click())
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('Not accepted')
      await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '只读核验当前冲突')!.click())
      expect(refresh).toHaveBeenCalledWith('/workspaces/source/conflict-context', { resolutionContextToken: 'old-signature' })
      expect(readGit).not.toHaveBeenCalled()
      expect(container.textContent).toContain('确认 Git 状态后明确重新执行原操作')
      expect(container.textContent).toContain('original.ts'); expect(close).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledTimes(1)
    } finally { act(() => root.unmount()); container.remove(); send.mockReset(); readGit.mockReset(); refresh.mockReset() }
  })

  it('revalidates the original proof against its actual target and resends to the original source Session', async () => {
    const container = document.createElement('div'); const root = createRoot(container)
    refresh.mockResolvedValue({ resolutionContextToken: 'renewed-original-scope' })
    try {
      act(() => root.render(<ResolveConflictsDialog open onOpenChange={() => {}} workspaceId="source" sourceWorkspaceId="source" targetWorkspaceId="other-target"
        targetWorktreePath="/actual-target" conflictOp={ConflictOp.MERGE} conflictedFiles={['original.ts']} sourceBranch="feature/source" targetBranch="target"
        currentSessionId="source-session" sessions={[]} resolutionContextToken="previous-process-proof" />))
      await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '只读核验当前冲突')!.click())
      expect(refresh).toHaveBeenCalledWith('/workspaces/source/conflict-context', { resolutionContextToken: 'previous-process-proof' })
      act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'AI 辅助解决')!.click())
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 'source-session', resolutionContextToken: 'renewed-original-scope' }), expect.any(Object))
      expect(container.textContent).toContain('original.ts'); expect(readGit).not.toHaveBeenCalled()
    } finally { act(() => root.unmount()); container.remove(); send.mockReset(); readGit.mockReset(); refresh.mockReset() }
  })

})
