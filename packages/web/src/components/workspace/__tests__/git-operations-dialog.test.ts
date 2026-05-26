import { describe, expect, it } from 'vitest'
import { ConflictOp } from '@agent-tower/shared'
import { ApiError } from '@/lib/api-client'
import { getConflictDetails } from '../GitOperationsDialog'

describe('GitOperationsDialog conflict details', () => {
  it('extracts only explicit merge conflict payloads', () => {
    const error = new ApiError(409, 'Merge conflict', {
      code: 'MERGE_CONFLICT',
      conflictOp: ConflictOp.MERGE,
      conflictedFiles: ['src/app.ts'],
      mergeAborted: true,
      mergeStrategy: 'no_ff',
      sourceBranch: 'feature/a',
      targetBranch: 'main',
      sourceWorkspaceId: 'child-ws',
      targetWorkspaceId: 'main-ws',
      sourceWorktreePath: '/tmp/child-ws',
      targetWorktreePath: '/tmp/main-ws',
    })

    expect(getConflictDetails(error)).toEqual({
      conflictOp: ConflictOp.MERGE,
      conflictedFiles: ['src/app.ts'],
      mergeAborted: true,
      mergeStrategy: 'no_ff',
      sourceBranch: 'feature/a',
      targetBranch: 'main',
      sourceWorkspaceId: 'child-ws',
      targetWorkspaceId: 'main-ws',
      sourceWorktreePath: '/tmp/child-ws',
      targetWorktreePath: '/tmp/main-ws',
    })
  })

  it('does not treat non-conflict 409 responses as conflicts', () => {
    expect(getConflictDetails(new ApiError(409, 'Merge lock busy', {
      code: 'TEAM_LOCK_CONFLICT',
    }))).toBeUndefined()

    expect(getConflictDetails(new ApiError(409, 'Rebase already in progress', {
      code: 'REBASE_IN_PROGRESS',
    }))).toBeUndefined()
  })

  it('rejects malformed conflict payloads', () => {
    expect(getConflictDetails(new ApiError(409, 'Missing files', {
      code: 'MERGE_CONFLICT',
      conflictOp: ConflictOp.MERGE,
    }))).toBeUndefined()

    expect(getConflictDetails(new ApiError(409, 'Invalid op', {
      code: 'MERGE_CONFLICT',
      conflictOp: 'UNKNOWN',
      conflictedFiles: ['src/app.ts'],
    }))).toBeUndefined()

    expect(getConflictDetails(new ApiError(409, 'Invalid files', {
      code: 'MERGE_CONFLICT',
      conflictOp: ConflictOp.REBASE,
      conflictedFiles: ['src/app.ts', 123],
    }))).toBeUndefined()
  })
})
