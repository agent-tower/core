const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 15_000];

export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface BeforeQuitHandlerOptions {
  stopBackend: () => Promise<void>;
  quit: () => void;
  onError?: (error: unknown) => void;
  setTimer?: typeof setTimeout;
}

/** Keep Electron's quit gate closed until backend cleanup really completes. */
export function createBeforeQuitHandler(options: BeforeQuitHandlerOptions): (event: BeforeQuitEvent) => void {
  const setTimer = options.setTimer ?? setTimeout;
  let quitting = false;
  let allowQuit = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;

  const attempt = () => {
    retryTimer = undefined;
    void options.stopBackend()
      .then(() => {
        allowQuit = true;
        options.quit();
      })
      .catch((error) => {
        options.onError?.(error);
        const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)]!;
        attempts += 1;
        retryTimer = setTimer(attempt, delay);
      });
  };

  return (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    attempt();
  };
}
