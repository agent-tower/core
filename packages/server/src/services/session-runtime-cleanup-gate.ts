import { prisma } from '../utils/index.js';

export const RUNTIME_LAUNCH_STATES = {
  NOT_STARTED: 'NOT_STARTED',
  CLAIMED: 'CLAIMED',
  PROCESS_RECORDED: 'PROCESS_RECORDED',
  REUSED: 'REUSED',
  SAFE_PRE_CHILD_FAILURE: 'SAFE_PRE_CHILD_FAILURE',
  QUARANTINED: 'QUARANTINED',
} as const;

export type RuntimeLaunchState = typeof RUNTIME_LAUNCH_STATES[keyof typeof RUNTIME_LAUNCH_STATES];

const QUARANTINE_DIAGNOSTIC_INTERVAL_MS = 5 * 60_000;

export interface RuntimeCleanupOwnershipObserver {
  hasActiveTurn?(sessionId: string): boolean;
  hasRuntimeProcessOwner?(
    runtimeInstanceId: string,
    sessionId?: string,
    launchClaimNumber?: number | null,
  ): boolean;
}

export interface RuntimeCleanupGateResult {
  confirmed: boolean;
  reason:
    | 'confirmed'
    | 'active_turn'
    | 'launch_unresolved'
    | 'launch_record_missing'
    | 'launch_quarantined'
    | 'ownership_unavailable'
    | 'ownership_incomplete'
    | 'cleanup_unconfirmed'
    | 'current_owner';
}

function nextDiagnosticAt(now: Date): Date {
  return new Date(now.getTime() + QUARANTINE_DIAGNOSTIC_INTERVAL_MS);
}

type SessionLaunchSnapshot = {
  runtimeLaunchState: string;
  runtimeLaunchClaimCount: number;
  runtimeLaunchResolvedCount: number;
  runtimeLaunchProcessCount: number;
  runtimeLaunchDiagnostic: string | null;
  runtimeLaunchDiagnosticCount: number;
  runtimeLaunchNextDiagnosticAt: Date | null;
};

type ProcessQuarantineSnapshot = {
  launchClaimNumber: number | null;
  runtimeInstanceId: string | null;
  pid: number | null;
  processGroupId: string | null;
  birthMarker: string | null;
  ownershipToken: string | null;
  cleanupState: string;
  cleanupError: string | null;
  cleanupAttemptCount: number;
  nextCleanupRetryAt: Date | null;
};

async function quarantineSessionLaunch(
  sessionId: string,
  diagnostic: string,
  now: Date,
  expected: SessionLaunchSnapshot,
): Promise<boolean> {
  if (
    expected.runtimeLaunchState === RUNTIME_LAUNCH_STATES.QUARANTINED
    && expected.runtimeLaunchDiagnostic === diagnostic
  ) return true;
  const result = await prisma.session.updateMany({
    where: {
      id: sessionId,
      runtimeLaunchState: expected.runtimeLaunchState,
      runtimeLaunchClaimCount: expected.runtimeLaunchClaimCount,
      runtimeLaunchResolvedCount: expected.runtimeLaunchResolvedCount,
      runtimeLaunchProcessCount: expected.runtimeLaunchProcessCount,
      runtimeLaunchDiagnostic: expected.runtimeLaunchDiagnostic,
      runtimeLaunchDiagnosticCount: expected.runtimeLaunchDiagnosticCount,
      runtimeLaunchNextDiagnosticAt: expected.runtimeLaunchNextDiagnosticAt,
    },
    data: {
      runtimeLaunchState: RUNTIME_LAUNCH_STATES.QUARANTINED,
      runtimeLaunchDiagnostic: diagnostic.slice(0, 2_000),
      runtimeLaunchDiagnosticCount: { increment: 1 },
      runtimeLaunchNextDiagnosticAt: nextDiagnosticAt(now),
    },
  });
  if (result.count > 0) {
    console.warn(`[RuntimeCleanupGate] Session ${sessionId} quarantined: ${diagnostic}`);
  }
  return result.count > 0;
}

async function quarantineProcess(
  processId: string,
  diagnostic: string,
  now: Date,
  expected: ProcessQuarantineSnapshot,
): Promise<boolean> {
  // A confirmed process is terminal evidence. Preserve it even when a legacy
  // row later proves to have incomplete metadata; a stale gate must never
  // downgrade confirmed cleanup into quarantine.
  if (expected.cleanupState === 'CONFIRMED') return true;
  if (expected.cleanupState === 'QUARANTINED' && expected.cleanupError === diagnostic) return true;
  const result = await prisma.executionProcess.updateMany({
    where: {
      id: processId,
      launchClaimNumber: expected.launchClaimNumber,
      runtimeInstanceId: expected.runtimeInstanceId,
      pid: expected.pid,
      processGroupId: expected.processGroupId,
      birthMarker: expected.birthMarker,
      ownershipToken: expected.ownershipToken,
      cleanupState: expected.cleanupState,
      cleanupError: expected.cleanupError,
      cleanupAttemptCount: expected.cleanupAttemptCount,
      nextCleanupRetryAt: expected.nextCleanupRetryAt,
    },
    data: {
      cleanupState: 'QUARANTINED',
      cleanupError: diagnostic.slice(0, 2_000),
      cleanupAttemptCount: { increment: 1 },
      nextCleanupRetryAt: nextDiagnosticAt(now),
    },
  });
  if (result.count > 0) {
    console.warn(`[RuntimeCleanupGate] ExecutionProcess ${processId} quarantined: ${diagnostic}`);
  }
  return result.count > 0;
}

/**
 * The only authority for deciding whether TeamRun terminal side effects may run.
 * It deliberately ignores Session.status: logical completion does not prove that
 * every launch claim was accounted for or that the owned OS tree is gone.
 */
export async function evaluateSessionRuntimeCleanup(
  sessionId: string,
  observer: RuntimeCleanupOwnershipObserver = {},
  now = new Date(),
): Promise<RuntimeCleanupGateResult> {
  return evaluateSessionRuntimeCleanupAttempt(sessionId, observer, now, 0);
}

async function evaluateSessionRuntimeCleanupAttempt(
  sessionId: string,
  observer: RuntimeCleanupOwnershipObserver,
  now: Date,
  casAttempt: number,
): Promise<RuntimeCleanupGateResult> {
  if (observer.hasActiveTurn?.(sessionId)) {
    return { confirmed: false, reason: 'active_turn' };
  }

  let session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      runtimeLaunchState: true,
      runtimeLaunchClaimCount: true,
      runtimeLaunchResolvedCount: true,
      runtimeLaunchProcessCount: true,
      runtimeLaunchDiagnostic: true,
      runtimeLaunchDiagnosticCount: true,
      runtimeLaunchNextDiagnosticAt: true,
    },
  });
  if (!session) return { confirmed: false, reason: 'launch_record_missing' };

  const processes = await prisma.executionProcess.findMany({
    where: { sessionId },
    select: {
      id: true,
      launchClaimNumber: true,
      runtimeInstanceId: true,
      pid: true,
      processGroupId: true,
      birthMarker: true,
      ownershipToken: true,
      cleanupState: true,
      cleanupError: true,
      cleanupAttemptCount: true,
      nextCleanupRetryAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  // db-push test databases and pre-migration rows can contain process evidence
  // without the new counters. Lazily applying the same conservative backfill as
  // the startup migration keeps that evidence authoritative. A legacy row may
  // already have a claim number when a process was recorded during a partial
  // rollout, so accept only a complete contiguous 1..N sequence. Missing or
  // duplicated claims remain quarantined instead of being guessed safe.
  const claimNumbers = processes.map((process) => process.launchClaimNumber);
  const normalizedClaimNumbers = claimNumbers.filter(
    (claim): claim is number => claim != null && Number.isInteger(claim) && claim > 0,
  );
  const hasCompleteLegacyClaims = claimNumbers.length > 0
    && normalizedClaimNumbers.length === claimNumbers.length
    && new Set(normalizedClaimNumbers).size === normalizedClaimNumbers.length
    && [...normalizedClaimNumbers].sort((a, b) => a - b).every((claim, index) => claim === index + 1);
  if (
    session.runtimeLaunchState === RUNTIME_LAUNCH_STATES.NOT_STARTED
    && session.runtimeLaunchClaimCount === 0
    && session.runtimeLaunchResolvedCount === 0
    && session.runtimeLaunchProcessCount === 0
    && processes.length > 0
    && (processes.every((process) => process.launchClaimNumber == null) || hasCompleteLegacyClaims)
  ) {
    await prisma.session.update({
      where: { id: sessionId },
      data: {
        runtimeLaunchState: RUNTIME_LAUNCH_STATES.PROCESS_RECORDED,
        runtimeLaunchClaimCount: processes.length,
        runtimeLaunchResolvedCount: processes.length,
        runtimeLaunchProcessCount: processes.length,
      },
    });
    session = {
      runtimeLaunchState: RUNTIME_LAUNCH_STATES.PROCESS_RECORDED,
      runtimeLaunchClaimCount: processes.length,
      runtimeLaunchResolvedCount: processes.length,
      runtimeLaunchProcessCount: processes.length,
      runtimeLaunchDiagnostic: null,
      runtimeLaunchDiagnosticCount: 0,
      runtimeLaunchNextDiagnosticAt: null,
    };
  }

  if (session.runtimeLaunchClaimCount !== session.runtimeLaunchResolvedCount) {
    const quarantined = await quarantineSessionLaunch(
      sessionId,
      `Runtime launch claim ${session.runtimeLaunchResolvedCount + 1} has no durable resolution; a child process may exist without an ExecutionProcess row`,
      now,
      session,
    );
    if (!quarantined && casAttempt < 3) {
      return evaluateSessionRuntimeCleanupAttempt(sessionId, observer, now, casAttempt + 1);
    }
    return { confirmed: false, reason: 'launch_unresolved' };
  }

  if (session.runtimeLaunchProcessCount !== processes.length) {
    const quarantined = await quarantineSessionLaunch(
      sessionId,
      `Runtime launch evidence expects ${session.runtimeLaunchProcessCount} process record(s), but ${processes.length} exist`,
      now,
      session,
    );
    if (!quarantined && casAttempt < 3) {
      return evaluateSessionRuntimeCleanupAttempt(sessionId, observer, now, casAttempt + 1);
    }
    return { confirmed: false, reason: 'launch_record_missing' };
  }

  if (session.runtimeLaunchState === RUNTIME_LAUNCH_STATES.QUARANTINED) {
    return { confirmed: false, reason: 'launch_quarantined' };
  }

  if (processes.length === 0) {
    const explicitNeverStarted = session.runtimeLaunchClaimCount === 0
      && session.runtimeLaunchState === RUNTIME_LAUNCH_STATES.NOT_STARTED;
    const safePreChildFailure = session.runtimeLaunchClaimCount > 0
      && session.runtimeLaunchState === RUNTIME_LAUNCH_STATES.SAFE_PRE_CHILD_FAILURE;
    if (explicitNeverStarted || safePreChildFailure) {
      return { confirmed: true, reason: 'confirmed' };
    }
    const quarantined = await quarantineSessionLaunch(
      sessionId,
      `Runtime launch state ${session.runtimeLaunchState} has no ExecutionProcess evidence`,
      now,
      session,
    );
    if (!quarantined && casAttempt < 3) {
      return evaluateSessionRuntimeCleanupAttempt(sessionId, observer, now, casAttempt + 1);
    }
    return { confirmed: false, reason: 'launch_record_missing' };
  }

  const hasRuntimeProcessOwner = observer.hasRuntimeProcessOwner;
  if (!hasRuntimeProcessOwner) {
    return { confirmed: false, reason: 'ownership_unavailable' };
  }

  for (const process of processes) {
    if (
      !Number.isInteger(process.launchClaimNumber)
      || process.launchClaimNumber! <= 0
      || !process.runtimeInstanceId
      || process.pid == null
      || !process.processGroupId
      || !process.birthMarker
      || !process.ownershipToken
    ) {
      const quarantined = await quarantineProcess(
        process.id,
        'Runtime ownership identity is incomplete; automated signalling and cleanup confirmation are disabled',
        now,
        process,
      );
      if (!quarantined && casAttempt < 3) {
        return evaluateSessionRuntimeCleanupAttempt(sessionId, observer, now, casAttempt + 1);
      }
      return { confirmed: false, reason: 'ownership_incomplete' };
    }
    if (process.cleanupState === 'QUARANTINED') {
      return { confirmed: false, reason: 'ownership_incomplete' };
    }
    if (process.cleanupState !== 'CONFIRMED') {
      return { confirmed: false, reason: 'cleanup_unconfirmed' };
    }
    if (hasRuntimeProcessOwner(process.runtimeInstanceId, sessionId, process.launchClaimNumber)) {
      return { confirmed: false, reason: 'current_owner' };
    }
  }

  return { confirmed: true, reason: 'confirmed' };
}

export async function reportDueRuntimeCleanupQuarantines(limit = 50, now = new Date()): Promise<number> {
  // Historical rows and interrupted writes can predate complete ownership
  // capture. Move them into an explicit durable quarantine before any retry
  // scanner can mistake them for signal-safe cleanup candidates.
  await prisma.executionProcess.updateMany({
    where: {
      cleanupState: { notIn: ['CONFIRMED', 'QUARANTINED'] },
      OR: [
        { launchClaimNumber: null },
        { runtimeInstanceId: null },
        { pid: null },
        { processGroupId: null },
        { birthMarker: null },
        { ownershipToken: null },
      ],
    },
    data: {
      cleanupState: 'QUARANTINED',
      cleanupError: 'Runtime ownership identity is incomplete; automated signalling and cleanup confirmation are disabled',
      cleanupAttemptCount: { increment: 1 },
      nextCleanupRetryAt: now,
    },
  });

  const [sessions, processes] = await Promise.all([
    prisma.session.findMany({
      where: {
        runtimeLaunchState: RUNTIME_LAUNCH_STATES.QUARANTINED,
        OR: [
          { runtimeLaunchNextDiagnosticAt: null },
          { runtimeLaunchNextDiagnosticAt: { lte: now } },
        ],
      },
      select: { id: true, runtimeLaunchDiagnostic: true },
      orderBy: [{ runtimeLaunchNextDiagnosticAt: 'asc' }, { updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    }),
    prisma.executionProcess.findMany({
      where: {
        cleanupState: 'QUARANTINED',
        OR: [{ nextCleanupRetryAt: null }, { nextCleanupRetryAt: { lte: now } }],
      },
      select: { id: true, sessionId: true, cleanupError: true },
      orderBy: [{ nextCleanupRetryAt: 'asc' }, { updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    }),
  ]);

  for (const session of sessions) {
    console.warn(
      `[RuntimeCleanupGate] Session ${session.id} remains quarantined: ${session.runtimeLaunchDiagnostic ?? 'unknown launch ownership'}`,
    );
    await prisma.session.updateMany({
      where: { id: session.id, runtimeLaunchState: RUNTIME_LAUNCH_STATES.QUARANTINED },
      data: {
        runtimeLaunchDiagnosticCount: { increment: 1 },
        runtimeLaunchNextDiagnosticAt: nextDiagnosticAt(now),
      },
    });
  }
  for (const process of processes) {
    console.warn(
      `[RuntimeCleanupGate] ExecutionProcess ${process.id} for Session ${process.sessionId} remains quarantined: ${process.cleanupError ?? 'unknown ownership'}`,
    );
    await prisma.executionProcess.updateMany({
      where: { id: process.id, cleanupState: 'QUARANTINED' },
      data: {
        cleanupAttemptCount: { increment: 1 },
        nextCleanupRetryAt: nextDiagnosticAt(now),
      },
    });
  }
  return sessions.length + processes.length;
}
