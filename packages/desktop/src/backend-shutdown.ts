import type { ChildProcess } from 'node:child_process';

const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 15_000];

/** Send the normal shutdown signal and wait for the backend's real exit. */
export function stopChildProcessAndWait(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const hasExited = () => child.exitCode !== null || child.signalCode !== null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (retryTimer) clearTimeout(retryTimer);
      child.removeListener('exit', done);
      child.removeListener('error', onError);
      resolve();
    };
    const scheduleRetry = () => {
      if (settled || retryTimer) return;
      const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS.at(-1)!;
      attempts += 1;
      // Keep the retry referenced: normal desktop quit is not allowed to
      // finish while backend cleanup is still unresolved.
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        attempt();
      }, delay);
    };
    const onError = () => {
      if (hasExited()) done();
      else scheduleRetry();
    };
    const attempt = () => {
      if (hasExited()) {
        done();
        return;
      }
      try {
        if (!child.kill(signal)) scheduleRetry();
      } catch {
        scheduleRetry();
      }
    };
    child.once('exit', done);
    child.on('error', onError);
    attempt();
  });
}
