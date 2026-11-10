/**
 * Work that will resume one of a task's sessions without a person acting.
 *
 * A task is ready for review only when its agents are done. "Done" is not just
 * "no session is running": an agent may have ended its run while Agent Tower
 * still owes it a turn (a pending wake-up), and a message may be queued for a
 * session whose run just ended. Moving such a task to IN_REVIEW tells the person
 * to review work that is about to change, and the next turn moves it back.
 */
import { prisma } from '../utils/index.js';
import { SessionPurpose, SessionStatus } from '../types/index.js';
import { ACTIVE_WAKEUP_STATES } from './session-wakeup.service.js';

const TERMINAL_SESSION_STATUSES: string[] = [SessionStatus.COMPLETED, SessionStatus.CANCELLED, SessionStatus.FAILED];
/** Delivery states that remove an entry from its session queue. */
const SETTLED_DELIVERY_STATES = ['SENT', 'CANCELLED'];
/**
 * A queue whose oldest unsettled entry is in one of these states is waiting for
 * a person (retry, send the original, confirm it was not sent); everything
 * behind it waits too, so it does not count as work in flight.
 */
const DELIVERY_STATES_AWAITING_PERSON = ['TRANSLATION_FAILED', 'PAUSED_DISABLED', 'DELIVERY_FAILED', 'DELIVERY_UNKNOWN'];

export interface TaskOutstandingWork {
  /** CHAT sessions of the task (COMMIT_MSG helpers excluded). */
  sessions: number;
  /** Sessions that have not reached a terminal status. */
  activeSessions: number;
  /** Wake-ups that will still start a turn. */
  pendingWakeups: number;
  /** Session queues whose next message will be dispatched without a person acting. */
  queuedDeliveries: number;
}

export function hasOutstandingWork(work: TaskOutstandingWork): boolean {
  return work.activeSessions > 0 || work.pendingWakeups > 0 || work.queuedDeliveries > 0;
}

export async function readTaskOutstandingWork(taskId: string): Promise<TaskOutstandingWork> {
  const sessionScope = { workspace: { taskId }, purpose: { not: SessionPurpose.COMMIT_MSG } };
  // A single read transaction is a single SQLite snapshot. A wake-up creates its
  // delivery row before it is marked FIRED, and a delivery stays unsettled until
  // its turn has claimed the session as RUNNING, so while a wake-up is on its
  // way the snapshot shows at least one of the three.
  const [sessions, pendingWakeups, unsettled] = await prisma.$transaction([
    prisma.session.findMany({ where: sessionScope, select: { status: true } }),
    prisma.sessionWakeup.count({ where: { state: { in: ACTIVE_WAKEUP_STATES }, session: sessionScope } }),
    prisma.messageDelivery.findMany({
      where: { state: { notIn: SETTLED_DELIVERY_STATES }, session: { is: sessionScope } },
      select: { channelKey: true, state: true },
      orderBy: { sequence: 'asc' },
    }),
  ]);
  const queueHeads = new Map<string, string>();
  for (const row of unsettled) {
    if (!queueHeads.has(row.channelKey)) queueHeads.set(row.channelKey, row.state);
  }
  return {
    sessions: sessions.length,
    activeSessions: sessions.filter((session) => !TERMINAL_SESSION_STATUSES.includes(session.status)).length,
    pendingWakeups,
    queuedDeliveries: [...queueHeads.values()].filter((state) => !DELIVERY_STATES_AWAITING_PERSON.includes(state)).length,
  };
}
