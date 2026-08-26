import { ReferencedShutdownCoordinator } from './shutdown-coordinator.js';

export interface ServerEntryShutdownOptions {
  closeApp: () => Promise<void>;
  destroyRuntime: () => Promise<void>;
  onAppCloseError?: (error: unknown) => void;
}

/**
 * Shared caller-level shutdown contract for the CLI and dev server entries.
 * Fastify hooks are one-shot, while runtime owners may need multiple retries.
 */
export function createServerEntryShutdownCoordinator(
  options: ServerEntryShutdownOptions,
  onRetryError?: (error: unknown, attempt: number) => void,
): ReferencedShutdownCoordinator {
  let appCloseAttempted = false;
  return new ReferencedShutdownCoordinator(
    async () => {
      if (!appCloseAttempted) {
        appCloseAttempted = true;
        try {
          await options.closeApp();
        } catch (error) {
          // Report the one-shot Fastify failure immediately; runtime cleanup
          // may itself need retries and must not hide this diagnostic.
          options.onAppCloseError?.(error);
        }
      }
      await options.destroyRuntime();
    },
    onRetryError,
  );
}
