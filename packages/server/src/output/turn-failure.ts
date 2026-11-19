/**
 * Why an agent turn failed, as far as the agent's own output says.
 *
 * Parsers report a cause next to their turn-failed signal, which only ends the
 * run. They report it for every failed top-level turn, including turns the CLI
 * started by itself after the delivered message (Claude continuation turns).
 * Policies act on the cause; the usage-limit resume is the first one.
 *
 * Only usage limits are recognised so far. Other kinds are added here when a
 * policy needs them.
 */
export interface UsageLimitTurnFailure {
  kind: 'usage_limit';
  /** When the provider says the limit lifts (ISO 8601), or null when it did not say. */
  resetsAt: string | null;
  /** The provider's name for the exhausted window, for example five_hour or seven_day. */
  limitType: string | null;
  /** The agent's own code for the failure, for example usage_limit_reached. */
  code: string | null;
  /** The text the agent showed for the failure. */
  message: string | null;
}

export type TurnFailureCause = UsageLimitTurnFailure;

/** Converts a Unix timestamp in seconds to ISO 8601; null for anything that is not a valid time. */
export function unixSecondsToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const ms = value * 1000;
  // Date's range is ±8.64e15 ms; a millisecond value passed as seconds lands outside it.
  if (ms > 8.64e15) return null;
  return new Date(ms).toISOString();
}
