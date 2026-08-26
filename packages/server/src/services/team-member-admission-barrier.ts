const memberAdmissionBarriers = new Map<string, Promise<void>>();

export function teamMemberAdmissionKey(teamRunId: string, memberId: string): string {
  return `scheduling:${teamRunId}:member:${memberId}`;
}

export async function acquireTeamMemberAdmission(
  teamRunId: string,
  memberId: string,
): Promise<() => void> {
  const key = teamMemberAdmissionKey(teamRunId, memberId);
  const previous = memberAdmissionBarriers.get(key) ?? Promise.resolve();
  let resolveHold!: () => void;
  const hold = new Promise<void>((resolve) => {
    resolveHold = resolve;
  });
  const current = previous.then(() => hold);
  memberAdmissionBarriers.set(key, current);
  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    resolveHold();
    if (memberAdmissionBarriers.get(key) === current) {
      memberAdmissionBarriers.delete(key);
    }
  };
}
