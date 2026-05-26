import { describe, expect, it } from 'vitest'
import { ConflictOp } from '@agent-tower/shared'
import {
  buildResolveConflictAiAction,
  buildResolveConflictsInstructions,
  buildTeamRunResolveConflictsMessage,
} from '../conflict-instructions'

describe('conflict instructions', () => {
  it('builds single-session conflict instructions with workspace context', () => {
    const instructions = buildResolveConflictsInstructions(
      'feature/a',
      'main',
      ['src/app.ts', 'src/app.test.ts'],
      ConflictOp.REBASE,
      {
        workspaceId: 'workspace-1',
        worktreePath: '/tmp/workspace-1',
        operation: 'rebase',
      },
    )

    expect(instructions).toContain('## Rebase 冲突解决')
    expect(instructions).toContain('- Workspace: `workspace-1`')
    expect(instructions).toContain('- Worktree: `/tmp/workspace-1`')
    expect(instructions).toContain('- Git 状态: `rebase`')
    expect(instructions).toContain('- src/app.ts')
    expect(instructions).toContain('git rebase --continue')
  })

  it('builds a TeamRun room message with conflict context and user intent', () => {
    const message = buildTeamRunResolveConflictsMessage({
      workspaceId: 'workspace-1',
      worktreePath: '/tmp/workspace-1',
      operation: 'merge',
      sourceBranch: 'feature/a',
      targetBranch: 'main',
      conflictedFiles: ['src/app.ts'],
      conflictOp: ConflictOp.MERGE,
    })

    expect(message).toContain('## 请求处理 Merge 冲突')
    expect(message).toContain('用户点击了“AI 辅助解决”')
    expect(message).toContain('- Workspace: `workspace-1`')
    expect(message).toContain('- Source branch: `feature/a`')
    expect(message).toContain('- Target branch: `main`')
    expect(message).toContain('- Conflict type: `MERGE`')
    expect(message).toContain('- src/app.ts')
    expect(message).toContain('Team Room 汇报处理结果')
  })

  it('describes aborted merge conflicts as a retry in the target context', () => {
    const instructions = buildResolveConflictsInstructions(
      'feature/a',
      'main',
      ['src/app.ts'],
      ConflictOp.MERGE,
      {
        mergeAborted: true,
        mergeStrategy: 'no_ff',
        sourceWorkspaceId: 'child-ws',
        targetWorkspaceId: 'main-ws',
        sourceWorktreePath: '/tmp/child-ws',
        targetWorktreePath: '/tmp/main-ws',
      },
    )

    expect(instructions).toContain('Merge state: conflict detected and already aborted by Agent Tower')
    expect(instructions).toContain('Target worktree: `/tmp/main-ws`')
    expect(instructions).toContain('当前不要假设存在冲突标记或 `MERGE_HEAD`')
    expect(instructions).toContain('git merge --no-ff feature/a')
    expect(instructions).toContain('`git merge --continue` 或 `git commit`')
  })

  it('keeps TeamRun messages useful when conflicted files are missing', () => {
    const message = buildTeamRunResolveConflictsMessage({
      sourceBranch: 'feature/a',
      targetBranch: 'main',
      conflictedFiles: [],
      conflictOp: ConflictOp.REBASE,
    })

    expect(message).toContain('- 未获取到冲突文件列表')
    expect(message).toContain('`git rebase --continue`')
  })

  it('routes TeamRun AI resolve to a room message', () => {
    const action = buildResolveConflictAiAction({
      teamRunId: 'team-run-1',
      workspaceId: 'workspace-1',
      sourceBranch: 'feature/a',
      targetBranch: 'main',
      conflictedFiles: ['src/app.ts'],
      conflictOp: ConflictOp.MERGE,
    })

    expect(action.type).toBe('team_room')
    expect(action).toMatchObject({
      type: 'team_room',
      message: expect.stringContaining('## 请求处理 Merge 冲突'),
    })
  })

  it('routes non-TeamRun AI resolve to the current session', () => {
    const action = buildResolveConflictAiAction({
      currentSessionId: 'session-current',
      selectedSessionId: 'session-selected',
      workspaceId: 'workspace-1',
      sourceBranch: 'feature/a',
      targetBranch: 'main',
      conflictedFiles: ['src/app.ts'],
      conflictOp: ConflictOp.REBASE,
    })

    expect(action).toMatchObject({
      type: 'session',
      sessionId: 'session-current',
      message: expect.stringContaining('## Rebase 冲突解决'),
    })
  })

  it('returns no AI resolve action when non-TeamRun has no session target', () => {
    expect(buildResolveConflictAiAction({
      workspaceId: 'workspace-1',
      sourceBranch: 'feature/a',
      targetBranch: 'main',
      conflictedFiles: ['src/app.ts'],
      conflictOp: ConflictOp.REBASE,
    })).toEqual({ type: 'none' })
  })
})
