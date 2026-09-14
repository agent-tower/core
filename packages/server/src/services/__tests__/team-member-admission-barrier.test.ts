import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireTeamMemberAdmission,
  MemberAdmissionBusyError,
} from '../team-member-admission-barrier.js';

describe('team member admission barrier', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fails fast with MEMBER_ADMISSION_BUSY instead of waiting on a stuck owner', async () => {
    const teamRunId = 'run-busy';
    const memberId = 'member-busy';
    const releaseStuckOwner = await acquireTeamMemberAdmission(teamRunId, memberId, {
      holder: 'stuck-owner',
    });

    await expect(
      acquireTeamMemberAdmission(teamRunId, memberId, { holder: 'stopMemberWork', timeoutMs: 20 }),
    ).rejects.toMatchObject({
      name: 'MemberAdmissionBusyError',
      code: 'MEMBER_ADMISSION_BUSY',
      statusCode: 409,
      holderLabel: 'stuck-owner',
    });

    // A fail-fast waiter must never force-release the real owner: the member
    // still cannot start a second concurrent session.
    await expect(
      acquireTeamMemberAdmission(teamRunId, memberId, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(MemberAdmissionBusyError);

    releaseStuckOwner();
  });

  it('passes an abandoned waiter slot through without breaking exclusivity', async () => {
    const teamRunId = 'run-chain';
    const memberId = 'member-chain';
    const releaseHolder = await acquireTeamMemberAdmission(teamRunId, memberId, { holder: 'holder' });

    await expect(
      acquireTeamMemberAdmission(teamRunId, memberId, { timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(MemberAdmissionBusyError);

    let secondAcquired = false;
    const second = acquireTeamMemberAdmission(teamRunId, memberId, { holder: 'second' }).then((release) => {
      secondAcquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondAcquired).toBe(false);

    releaseHolder();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
  });

  it('warns when a labeled holder keeps the barrier beyond the hold threshold', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const release = await acquireTeamMemberAdmission('run-warn', 'member-warn', { holder: 'slow-owner' });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("held by 'slow-owner'"));
    release();
  });
});
