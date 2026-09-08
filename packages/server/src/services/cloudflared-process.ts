import type { ChildProcess } from 'node:child_process';

export interface ManagedCloudflaredTunnel {
  readonly process?: ChildProcess;
  stop(): boolean | void;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface TunnelOwner {
  exited: boolean;
  exit: Promise<void>;
  stopping: Promise<void> | null;
}

const owners = new WeakMap<ManagedCloudflaredTunnel, TunnelOwner>();

/** Register immediately after spawn, including exits that happen before stop. */
export function trackCloudflaredTunnel(tunnel: ManagedCloudflaredTunnel): void {
  if (owners.has(tunnel)) return;
  let resolveExit!: () => void;
  const owner: TunnelOwner = {
    exited: tunnel.process?.exitCode != null || tunnel.process?.signalCode != null,
    exit: new Promise<void>((resolve) => { resolveExit = resolve; }),
    stopping: null,
  };
  owners.set(tunnel, owner);
  if (owner.exited) resolveExit();
  else tunnel.once('exit', () => { owner.exited = true; resolveExit(); });
}

async function waitForExit(owner: TunnelOwner, timeoutMs: number): Promise<boolean> {
  if (owner.exited) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      owner.exit.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A successful signal is not an exit. Failed cleanup remains retryable. */
export async function stopCloudflaredTunnel(tunnel: ManagedCloudflaredTunnel): Promise<void> {
  trackCloudflaredTunnel(tunnel);
  const owner = owners.get(tunnel)!;
  if (owner.exited) return;
  // A failed child_process spawn has no OS process and emits error, not exit.
  if (tunnel.process && !tunnel.process.pid) return;
  if (owner.stopping) return owner.stopping;
  const stopping = (async () => {
    tunnel.stop();
    if (await waitForExit(owner, 1_000)) return;
    tunnel.process?.kill('SIGKILL');
    if (await waitForExit(owner, 2_000)) return;
    throw new Error('cloudflared did not exit after forced termination');
  })();
  owner.stopping = stopping;
  try {
    await stopping;
  } finally {
    if (owner.stopping === stopping) owner.stopping = null;
  }
}

/** Abort the caller promptly without waiting for an uninterruptible download. */
export async function waitForTunnelBinary(ready: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
