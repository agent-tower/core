import { WorkspaceKind, WorkspaceStatus, type TeamRun, type Workspace } from '@agent-tower/shared'

export type WorkspaceViewKind = 'main' | 'child' | 'root'

export interface WorkspaceView {
  workspace: Workspace
  kind: WorkspaceViewKind
  roleLabel: string
  displayName: string
  ownerName?: string
  parentBranchName?: string
  isMain: boolean
}

function shortId(value?: string | null) {
  return value ? value.slice(0, 8) : ''
}

function workspaceTime(value?: string) {
  const parsed = value ? Date.parse(value) : 0
  return Number.isNaN(parsed) ? 0 : parsed
}

export function isMainDirectoryWorkspace(workspace?: Workspace | null) {
  return workspace?.workspaceKind === WorkspaceKind.MAIN_DIRECTORY
}

export function getWorkspaceBranchLabel(workspace?: Workspace | null) {
  if (!workspace) return '—'
  return isMainDirectoryWorkspace(workspace) ? 'Project directory' : workspace.branchName
}

export function getWorkspaceWorkingDir(workspace?: Workspace | null) {
  return workspace?.workingDir || workspace?.worktreePath || undefined
}

export function buildWorkspaceViews(
  workspaces: Workspace[] | undefined,
  teamRun?: TeamRun | null,
): WorkspaceView[] {
  if (!workspaces?.length) return []

  const memberById = new Map((teamRun?.members ?? []).map((member) => [member.id, member]))
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const mainWorkspaceId = teamRun?.mainWorkspaceId ?? null

  return workspaces
    .map((workspace) => {
      const parent = workspace.parentWorkspaceId
        ? workspaceById.get(workspace.parentWorkspaceId)
        : undefined
      const owner = workspace.ownerMemberId
        ? memberById.get(workspace.ownerMemberId)
        : undefined
      const isMain = Boolean(mainWorkspaceId && workspace.id === mainWorkspaceId)
      const kind: WorkspaceViewKind = isMain ? 'main' : workspace.parentWorkspaceId ? 'child' : 'root'
      const ownerName = owner?.name ?? (workspace.ownerMemberId ? `Member ${shortId(workspace.ownerMemberId)}` : undefined)
      const displayName = isMainDirectoryWorkspace(workspace)
        ? 'Project directory'
        : isMain
        ? 'Main workspace'
        : kind === 'child'
          ? ownerName ? `${ownerName} workspace` : 'Child workspace'
          : teamRun ? 'Root workspace' : 'Workspace'

      return {
        workspace,
        kind,
        roleLabel: isMain ? 'Main' : kind === 'child' ? 'Child' : 'Root',
        displayName,
        ownerName,
        parentBranchName: parent ? getWorkspaceBranchLabel(parent) : undefined,
        isMain,
      }
    })
    .sort((a, b) => {
      const rank = (view: WorkspaceView) => {
        if (view.kind === 'main') return 0
        if (view.kind === 'child') return 1
        return 2
      }
      const rankDelta = rank(a) - rank(b)
      if (rankDelta !== 0) return rankDelta
      return workspaceTime(a.workspace.createdAt) - workspaceTime(b.workspace.createdAt)
    })
}

export function resolveDefaultWorkspaceId(
  workspaces: Workspace[] | undefined,
  teamRun?: TeamRun | null,
  explicitWorkspaceId?: string | null,
): string | undefined {
  if (!workspaces?.length) return undefined

  if (explicitWorkspaceId && workspaces.some((workspace) => workspace.id === explicitWorkspaceId)) {
    return explicitWorkspaceId
  }

  if (teamRun?.mainWorkspaceId && workspaces.some((workspace) => workspace.id === teamRun.mainWorkspaceId)) {
    return teamRun.mainWorkspaceId
  }

  return workspaces.find((workspace) => workspace.status === WorkspaceStatus.ACTIVE)?.id
    ?? workspaces[0]?.id
}

export function canRunWorkspaceGitOperations(
  workspace: Workspace | undefined,
  teamRun?: TeamRun | null,
) {
  if (!workspace || workspace.status !== WorkspaceStatus.ACTIVE) return false
  if (isMainDirectoryWorkspace(workspace)) return false
  if (!teamRun) return true
  if (workspace.parentWorkspaceId) return true
  return Boolean(teamRun.mainWorkspaceId && workspace.id === teamRun.mainWorkspaceId)
}

export function getWorkspaceMergeTargetBranch(
  workspace: Workspace | undefined,
  workspaces: Workspace[] | undefined,
  projectMainBranch: string,
) {
  if (!workspace?.parentWorkspaceId) return projectMainBranch
  const parent = workspaces?.find((item) => item.id === workspace.parentWorkspaceId)
  return parent?.branchName ?? workspace.baseBranch ?? projectMainBranch
}
