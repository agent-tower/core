/**
 * Parent-owned cleanup completion latch.
 *
 * The previous implementation exposed a TCP endpoint and bearer secret in the
 * wrapper environment. An Agent child can inspect its parent environment on
 * Unix, so that was not an origin proof. Completion is now an in-process
 * capability: only the parent launch owner receives `markCompleted`, and the
 * wrapper has no completion material to inherit or echo.
 */
export interface TreeCleanupChannel {
  /** Deliberately empty: no completion endpoint, secret, or evidence path. */
  readonly env: Record<string, string>;
  isCompleted(): boolean;
  markCompleted(): void;
  close(): void;
}

export async function createTreeCleanupChannel(): Promise<TreeCleanupChannel> {
  let completed = false;
  let closed = false;
  return {
    env: {},
    isCompleted: () => completed,
    markCompleted: () => {
      if (!closed) completed = true;
    },
    close: () => {
      closed = true;
    },
  };
}
