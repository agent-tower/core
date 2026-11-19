/**
 * Usage-limit resume: when a turn stops because the account reached its usage
 * limit, Agent Tower schedules one ordinary wake-up for shortly after the limit
 * resets, so the session continues without a person typing "continue".
 *
 * Everything after scheduling is the normal wake-up behaviour: a person can
 * cancel it, it never interrupts a running turn, the task stays in progress
 * while it is pending, and the per-session daily cap applies. When the resumed
 * turn hits a limit again, that stop schedules the next resume.
 *
 * Scope: chat sessions of tasks. Team-run members are left out, because wake-up
 * delivery is not admitted for them. A global setting turns the feature off.
 */
import type { EventBus } from '../core/event-bus.js';
import type { TurnFailureCause } from '../output/turn-failure.js';
import { SessionPurpose } from '../types/index.js';
import { prisma } from '../utils/index.js';
import { writeErrorLog } from '../utils/error-log.js';
import type { SessionWakeupService } from './session-wakeup.service.js';

/** Wake this long after the reset time, so the provider's window has certainly reset. */
export const USAGE_LIMIT_RESUME_DELAY_MS = 2 * 60_000;
/** A reset further out than this is not a plausible usage-limit window; nothing is scheduled. */
export const MAX_USAGE_LIMIT_WAIT_MS = 35 * 24 * 60 * 60_000;

/** The global switch; on unless a person turned it off. */
export async function isUsageLimitResumeEnabled(): Promise<boolean> {
  const settings = await prisma.appSettings.findUnique({
    where: { id: 'singleton' },
    select: { autoResumeAfterUsageLimit: true },
  });
  return settings?.autoResumeAfterUsageLimit ?? true;
}

export interface UsageLimitResumeOptions {
  eventBus: EventBus;
  wakeups: Pick<SessionWakeupService, 'scheduleUsageLimitResume'>;
  isEnabled?: () => Promise<boolean>;
  now?: () => Date;
}

export class UsageLimitResume {
  private unsubscribe?: () => void;
  private readonly isEnabled: () => Promise<boolean>;
  private readonly now: () => Date;

  constructor(private readonly options: UsageLimitResumeOptions) {
    this.isEnabled = options.isEnabled ?? isUsageLimitResumeEnabled;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.unsubscribe) return;
    const listener = ({ sessionId, cause }: { sessionId: string; cause: TurnFailureCause }) => {
      void this.handle(sessionId, cause).catch((error) => {
        writeErrorLog({
          level: 'warn',
          source: 'usageLimitResume',
          message: '[UsageLimitResume] could not schedule the resume',
          error,
          metadata: { sessionId },
        });
      });
    };
    this.options.eventBus.on('session:turn-failure-cause', listener);
    this.unsubscribe = () => this.options.eventBus.off('session:turn-failure-cause', listener);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Schedules the resume for a usage-limit stop; returns its fire time, or null when none applies. */
  async handle(sessionId: string, cause: TurnFailureCause): Promise<Date | null> {
    if (cause.kind !== 'usage_limit' || !cause.resetsAt) return null;
    const resetAt = Date.parse(cause.resetsAt);
    const now = this.now().getTime();
    if (!Number.isFinite(resetAt) || resetAt - now > MAX_USAGE_LIMIT_WAIT_MS) return null;
    if (!(await this.isEnabled())) return null;
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { purpose: true, conversationId: true, workspaceId: true },
    });
    if (!session || session.purpose !== SessionPurpose.CHAT || session.conversationId || !session.workspaceId) return null;
    if (await prisma.agentInvocation.findFirst({ where: { sessionId }, select: { id: true } })) return null;
    const fireAt = new Date(Math.max(resetAt, now) + USAGE_LIMIT_RESUME_DELAY_MS);
    const message = cause.message?.trim().slice(0, 500) || null;
    await this.options.wakeups.scheduleUsageLimitResume({
      sessionId,
      fireAt,
      reason: message ?? 'Usage limit reached',
      payload: { resetsAt: cause.resetsAt, limitType: cause.limitType, code: cause.code, message },
    });
    return fireAt;
  }
}
