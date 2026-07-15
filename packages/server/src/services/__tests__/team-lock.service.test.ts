import { describe, expect, it } from 'vitest';
import type { TeamMemberCapabilities, WorkspacePolicy } from '@agent-tower/shared';
import { TeamLockService, type LockRequest } from '../team-lock.service.js';

const readOnlyCapabilities: TeamMemberCapabilities = {
  readRoom: true,
  postRoomMessage: true,
  mentionMembers: true,
  stopMemberWork: false,
  markReadyForReview: false,
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  readDiff: true,
  mergeWorkspace: false,
};

function lockRequest(
  capabilities: Partial<TeamMemberCapabilities>,
  workspacePolicy: WorkspacePolicy = 'shared'
): LockRequest {
  return {
    teamRunId: 'team-run-1',
    memberId: 'member-1',
    workspaceId: 'workspace-1',
    workspacePolicy,
    capabilities: { ...readOnlyCapabilities, ...capabilities },
  };
}

describe('TeamLockService', () => {
  it('does not require locks for read-only capabilities', () => {
    const service = new TeamLockService();

    expect(service.getRequiredLocks(lockRequest({}))).toEqual([]);
  });

  it('requires a workspace write lock for shared writeFiles members', () => {
    const service = new TeamLockService();

    expect(service.getRequiredLocks(lockRequest({ writeFiles: true }))).toEqual([
      'workspace:workspace-1:write',
    ]);
  });

  it('requires a workspace command lock for shared runCommands members', () => {
    const service = new TeamLockService();

    expect(service.getRequiredLocks(lockRequest({ runCommands: true }))).toEqual([
      'workspace:workspace-1:command',
    ]);
  });

  it('does not reserve merge resources for mergeWorkspace members', () => {
    const service = new TeamLockService();

    expect(service.getRequiredLocks(lockRequest({ mergeWorkspace: true }))).toEqual([]);
  });

  it('does not reserve merge resources for none-policy members', () => {
    const service = new TeamLockService();

    expect(service.getRequiredLocks(lockRequest({ mergeWorkspace: true }, 'none'))).toEqual([]);
  });

  it('does not require workspace write or command locks when workspacePolicy is none', () => {
    const service = new TeamLockService();

    expect(service.getRequiredLocks(lockRequest({
      writeFiles: true,
      runCommands: true,
    }, 'none'))).toEqual([]);
  });

  it('prevents different owners from acquiring the same lock until release', () => {
    const service = new TeamLockService();

    expect(service.acquire('owner-1', ['workspace:workspace-1:write'])).toBe(true);
    expect(service.acquire('owner-2', ['workspace:workspace-1:write'])).toBe(false);

    service.releaseByOwner('owner-1');

    expect(service.acquire('owner-2', ['workspace:workspace-1:write'])).toBe(true);
  });

  it('does not partially acquire multiple locks when any requested lock is held', () => {
    const service = new TeamLockService();

    expect(service.acquire('owner-1', ['workspace:workspace-1:write'])).toBe(true);
    expect(service.acquire('owner-2', [
      'workspace:workspace-1:write',
      'workspace:workspace-1:command',
    ])).toBe(false);

    expect(service.listLocks()).toEqual([
      { key: 'workspace:workspace-1:write', ownerId: 'owner-1' },
    ]);
    expect(service.canAcquire(['workspace:workspace-1:command'])).toBe(true);
  });
});
