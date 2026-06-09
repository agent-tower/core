import { WorkspaceKind } from '../types/index.js';

export interface WorkspaceKindRecord {
  workspaceKind?: string | null;
}

export interface WorkspacePathRecord extends WorkspaceKindRecord {
  worktreePath: string;
  workingDir?: string | null;
}

export function getWorkspaceKind(workspace: WorkspaceKindRecord): WorkspaceKind {
  return workspace.workspaceKind === WorkspaceKind.MAIN_DIRECTORY
    ? WorkspaceKind.MAIN_DIRECTORY
    : WorkspaceKind.WORKTREE;
}

export function isWorktreeWorkspace(workspace: WorkspaceKindRecord): boolean {
  return getWorkspaceKind(workspace) === WorkspaceKind.WORKTREE;
}

export function isMainDirectoryWorkspace(workspace: WorkspaceKindRecord): boolean {
  return getWorkspaceKind(workspace) === WorkspaceKind.MAIN_DIRECTORY;
}

export function getWorkspaceWorkingDir(workspace: WorkspacePathRecord): string {
  return workspace.workingDir || workspace.worktreePath;
}
