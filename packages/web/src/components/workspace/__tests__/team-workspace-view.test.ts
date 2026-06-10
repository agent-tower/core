import { describe, expect, it } from 'vitest'
import { WorkspaceKind, WorkspaceStatus, type TeamRun, type Workspace } from '@agent-tower/shared'
import {
  buildWorkspaceViews,
  canRunWorkspaceGitOperations,
  getWorkspaceMergeTargetBranch,
  resolveDefaultWorkspaceId,
} from '../team-workspace-view'

function workspace(input: Partial<Workspace> & Pick<Workspace, 'id' | 'branchName'>): Workspace {
  return {
    id: input.id,
    taskId: input.taskId ?? 'task-1',
    branchName: input.branchName,
    worktreePath: input.worktreePath ?? `/tmp/${input.id}`,
    workspaceKind: input.workspaceKind ?? WorkspaceKind.WORKTREE,
    workingDir: input.workingDir ?? input.worktreePath ?? `/tmp/${input.id}`,
    status: input.status ?? WorkspaceStatus.ACTIVE,
    parentWorkspaceId: input.parentWorkspaceId ?? null,
    ownerMemberId: input.ownerMemberId ?? null,
    baseBranch: input.baseBranch ?? null,
    createdAt: input.createdAt,
  }
}

const teamRun = {
  id: 'team-run-1',
  taskId: 'task-1',
  mainWorkspaceId: 'main-ws',
  mode: 'AUTO',
  members: [
    {
      id: 'member-1',
      teamRunId: 'team-run-1',
      name: 'Full Stack #1',
      aliases: [],
      providerId: 'provider-1',
      rolePrompt: 'role',
      capabilities: {
        readRoom: true,
        postRoomMessage: true,
        mentionMembers: true,
        stopMemberWork: true,
        markReadyForReview: true,
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        readDiff: true,
        mergeWorkspace: true,
      },
      workspacePolicy: 'dedicated',
      triggerPolicy: 'MENTION_ONLY',
      sessionPolicy: 'new_per_request',
      queueManagementPolicy: 'own_only',
      membershipStatus: 'ACTIVE',
      status: 'IDLE',
    },
  ],
} satisfies TeamRun

describe('team workspace view helpers', () => {
  it('labels TeamRun main, dedicated child, and extra root workspaces distinctly', () => {
    const views = buildWorkspaceViews([
      workspace({ id: 'extra-root', branchName: 'at/extra-root', createdAt: '2026-05-26T00:03:00.000Z' }),
      workspace({ id: 'child-ws', branchName: 'at/team/member-1', parentWorkspaceId: 'main-ws', ownerMemberId: 'member-1', createdAt: '2026-05-26T00:02:00.000Z' }),
      workspace({ id: 'main-ws', branchName: 'at/team/main', createdAt: '2026-05-26T00:01:00.000Z' }),
    ], teamRun)

    expect(views.map((view) => [view.workspace.id, view.roleLabel, view.displayName])).toEqual([
      ['main-ws', 'Main', 'Main workspace'],
      ['child-ws', 'Child', 'Full Stack #1 workspace'],
      ['extra-root', 'Root', 'Root workspace'],
    ])
  })

  it('defaults TeamRun views to the bound main workspace and preserves explicit selection', () => {
    const workspaces = [
      workspace({ id: 'child-ws', branchName: 'at/team/member-1', parentWorkspaceId: 'main-ws', ownerMemberId: 'member-1' }),
      workspace({ id: 'main-ws', branchName: 'at/team/main' }),
    ]

    expect(resolveDefaultWorkspaceId(workspaces, teamRun)).toBe('main-ws')
    expect(resolveDefaultWorkspaceId(workspaces, teamRun, 'child-ws')).toBe('child-ws')
  })

  it('switches an implicit active child/root fallback to main when TeamRun data arrives', () => {
    const workspaces = [
      workspace({ id: 'child-ws', branchName: 'at/team/member-1', parentWorkspaceId: 'main-ws', ownerMemberId: 'member-1' }),
      workspace({ id: 'main-ws', branchName: 'at/team/main' }),
    ]

    expect(resolveDefaultWorkspaceId(workspaces, null, undefined)).toBe('child-ws')
    expect(resolveDefaultWorkspaceId(workspaces, teamRun, undefined)).toBe('main-ws')
  })

  it('does not override an explicit child selection when TeamRun data arrives', () => {
    const workspaces = [
      workspace({ id: 'main-ws', branchName: 'at/team/main' }),
      workspace({ id: 'child-ws', branchName: 'at/team/member-1', parentWorkspaceId: 'main-ws', ownerMemberId: 'member-1' }),
    ]

    expect(resolveDefaultWorkspaceId(workspaces, teamRun, 'child-ws')).toBe('child-ws')
  })

  it('targets a child workspace merge at its parent branch', () => {
    const mainWorkspace = workspace({ id: 'main-ws', branchName: 'at/team/main' })
    const childWorkspace = workspace({
      id: 'child-ws',
      branchName: 'at/team/member-1',
      parentWorkspaceId: mainWorkspace.id,
      baseBranch: mainWorkspace.branchName,
    })

    expect(getWorkspaceMergeTargetBranch(childWorkspace, [mainWorkspace, childWorkspace], 'main')).toBe('at/team/main')
    expect(getWorkspaceMergeTargetBranch(mainWorkspace, [mainWorkspace, childWorkspace], 'main')).toBe('main')
  })

  it('allows Git operations only for valid active workspace targets', () => {
    const mainWorkspace = workspace({ id: 'main-ws', branchName: 'at/team/main' })
    const childWorkspace = workspace({
      id: 'child-ws',
      branchName: 'at/team/member-1',
      parentWorkspaceId: mainWorkspace.id,
      ownerMemberId: 'member-1',
    })
    const extraRootWorkspace = workspace({ id: 'extra-root', branchName: 'at/extra-root' })
    const mainDirectoryWorkspace = workspace({
      id: 'main-directory',
      branchName: '',
      worktreePath: '',
      workspaceKind: WorkspaceKind.MAIN_DIRECTORY,
      workingDir: '/tmp/project',
    })
    const hibernatedMainWorkspace = workspace({
      id: 'main-ws',
      branchName: 'at/team/main',
      status: WorkspaceStatus.HIBERNATED,
    })

    expect(canRunWorkspaceGitOperations(mainWorkspace, teamRun)).toBe(true)
    expect(canRunWorkspaceGitOperations(childWorkspace, teamRun)).toBe(true)
    expect(canRunWorkspaceGitOperations(extraRootWorkspace, teamRun)).toBe(false)
    expect(canRunWorkspaceGitOperations(hibernatedMainWorkspace, teamRun)).toBe(false)
    expect(canRunWorkspaceGitOperations(extraRootWorkspace, null)).toBe(true)
    expect(canRunWorkspaceGitOperations(mainDirectoryWorkspace, null)).toBe(false)
  })
})
