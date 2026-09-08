import { ReferencedShutdownCoordinator } from './shutdown-coordinator.js';

/** Install before asynchronous startup so a parent can stop an unready host. */
export function installServerEntryShutdownRequests(
  host: Pick<NodeJS.Process, 'on' | 'off'> = process,
) {
  let handler: ((source: string) => void) | undefined;
  let requestedSource: string | undefined;
  const request = (source: string) => {
    requestedSource = source;
    handler?.(source);
  };
  const sigterm = () => request('SIGTERM');
  const sigint = () => request('SIGINT');
  const disconnected = () => request('parent disconnect');
  const message = (value: unknown) => {
    if (value && typeof value === 'object' && 'type' in value && value.type === 'agent-tower:shutdown') {
      request('parent IPC');
    }
  };
  host.on('SIGTERM', sigterm);
  host.on('SIGINT', sigint);
  host.on('message', message);
  host.on('disconnect', disconnected);
  return {
    get requested() { return requestedSource !== undefined; },
    setHandler(nextHandler: (source: string) => void) {
      handler = nextHandler;
      if (requestedSource) handler(requestedSource);
    },
    dispose() {
      host.off('SIGTERM', sigterm);
      host.off('SIGINT', sigint);
      host.off('message', message);
      host.off('disconnect', disconnected);
    },
  };
}

export interface ServerEntryShutdownOptions {
  closeApp: () => Promise<void>;
  destroyRuntime: () => Promise<void>;
  onAppCloseError?: (error: unknown) => void;
}

/** IPC listeners intentionally keep the backend alive until this final exit. */
export async function finishFailedServerEntry(
  shutdown: ReferencedShutdownCoordinator | undefined,
  exit: (code: number) => void = (code) => { process.exit(code); },
): Promise<void> {
  if (shutdown) await shutdown.request();
  exit(1);
}

/**
 * Shared caller-level shutdown contract for the CLI and dev server entries.
 * Fastify hooks are one-shot, while runtime owners may need multiple retries.
 */
export function createServerEntryShutdownCoordinator(
  options: ServerEntryShutdownOptions,
  onRetryError?: (error: unknown, attempt: number) => void,
): ReferencedShutdownCoordinator {
  let appClosePromise: Promise<void> | undefined;
  return new ReferencedShutdownCoordinator(
    async () => {
      if (!appClosePromise) {
        appClosePromise = (async () => {
          try {
            await options.closeApp();
          } catch (error) {
            // Diagnostics must not prevent process owners from being retried.
            try { options.onAppCloseError?.(error); } catch { /* logging only */ }
          }
        })();
      }
      // HTTP close can wait for onReady or an active request that itself needs
      // a child to stop. Start cleanup immediately, and keep retrying owners
      // even while the one-shot network close is still pending.
      await options.destroyRuntime();
      await appClosePromise;
    },
    onRetryError,
  );
}
