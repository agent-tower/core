/**
 * Client-side error log.
 *
 * `console.error` is this package's existing error-log channel: every other
 * failure path in `packages/web` reports through it (see `session-log-store`,
 * `useNormalizedLogs`, `socket/manager`). This module keeps render-error
 * reports in the same channel but with a structured, greppable payload
 * (`[error-log] <source>` + entry object) so a report can be located from the
 * browser console / desktop log output instead of being swallowed.
 *
 * The entry is deliberately a plain serialisable object: if a remote sink
 * (e.g. the server's `writeErrorLog`) is added later, only `logClientError`
 * needs to change.
 */

export interface ClientErrorLogContext {
  /** React component stack captured by an error boundary. */
  componentStack?: string | null
  /** Extra, non-sensitive facts that help locate the failure. */
  metadata?: Record<string, unknown>
}

export interface ClientErrorLogEntry {
  time: string
  source: string
  name: string
  message: string
  stack?: string
  componentStack?: string
  metadata?: Record<string, unknown>
}

export function toClientErrorLogEntry(
  source: string,
  error: unknown,
  context: ClientErrorLogContext = {},
): ClientErrorLogEntry {
  const normalized = error instanceof Error ? error : new Error(stringifyThrown(error))
  return {
    time: new Date().toISOString(),
    source,
    name: normalized.name,
    message: normalized.message,
    ...(normalized.stack ? { stack: normalized.stack } : {}),
    ...(context.componentStack ? { componentStack: context.componentStack } : {}),
    ...(context.metadata ? { metadata: context.metadata } : {}),
  }
}

/** Write one structured entry to the existing error log. Never throws. */
export function logClientError(
  source: string,
  error: unknown,
  context: ClientErrorLogContext = {},
): void {
  try {
    console.error(`[error-log] ${source}`, toClientErrorLogEntry(source, error, context))
  } catch {
    // Logging must never take down the fallback UI it is reporting.
  }
}

function stringifyThrown(error: unknown): string {
  if (typeof error === 'string') return error
  if (error === undefined) return 'undefined'
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}
