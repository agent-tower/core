import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ReferencedShutdownCoordinator } from '../runtime/shutdown-coordinator.js';
import { assertApplicationProcessStartAllowed, registerApplicationProcessCleanup } from '../runtime/application-process-cleanup.js';
import { createWindowsProcessTreeAdapter, type WindowsProcessIdentity, type WindowsProcessTreeAdapter } from '../runtime/acp/process-manager.js';
import { createUnixProcessIdentityAdapter, PROCESS_IDENTITY_ENV, type UnixProcessIdentityAdapter } from './unix-process-identity.js';

export interface ChildProcessOwner { stop(): Promise<void> }

const activeOwners = new Set<ChildProcessOwner>();

/** Used by application shutdown as well as the individual command caller. */
export async function shutdownOwnedChildProcesses(): Promise<void> {
  await Promise.all([...activeOwners].map((owner) => owner.stop()));
}

/** Owns a launch token independently of the direct child's exit event. */
export class OwnedChildProcess implements ChildProcessOwner {
  private exited = false;
  private readonly unix: UnixProcessIdentityAdapter;
  private readonly windows: WindowsProcessTreeAdapter;
  private readonly platform: NodeJS.Platform;
  private readonly windowsMembers = new Map<number, WindowsProcessIdentity>();
  private windowsRoot?: WindowsProcessIdentity;
  private unixRootCaptured = false;
  private stopping = false;
  private readonly initialCapture: Promise<void>;
  private readonly captureTimer: ReturnType<typeof setInterval>;
  private capturePromise?: Promise<import('./unix-process-identity.js').UnixProcessGroupIdentity[]>;
  private readonly shutdown: ReferencedShutdownCoordinator;

  constructor(
    private readonly child: ChildProcess,
    private readonly token: string,
    options: { graceMs?: number; platform?: NodeJS.Platform; unix?: UnixProcessIdentityAdapter; windows?: WindowsProcessTreeAdapter } = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.unix = options.unix ?? createUnixProcessIdentityAdapter(this.platform);
    this.windows = options.windows ?? createWindowsProcessTreeAdapter();
    this.exited = child.exitCode !== null && child.exitCode !== undefined
      || child.signalCode !== null && child.signalCode !== undefined;
    child.once('exit', () => { this.exited = true; });
    child.once('error', () => { if (!child.pid) this.exited = true; });
    // Keep a rejected probe retryable; a failed observation proves nothing.
    this.initialCapture = this.capture().then(() => undefined);
    void this.initialCapture.catch(() => undefined);
    this.captureTimer = setInterval(() => {
      if (!this.stopping) void this.capture().catch(() => undefined);
    }, this.platform === 'win32' ? 1_000 : 100);
    this.captureTimer.unref?.();
    this.shutdown = new ReferencedShutdownCoordinator(async () => {
      await this.initialCapture.catch(() => undefined);
      const alreadyExited = await this.signal('SIGTERM');
      if (!alreadyExited && !await this.waitForExit(options.graceMs ?? 2_000)) {
        await this.signal('SIGKILL');
        if (!await this.waitForExit(2_000)) throw new Error('Child process tree cleanup remains pending');
      }
      clearInterval(this.captureTimer);
      await this.capturePromise;
      activeOwners.delete(this);
      this.unix.releaseOwnership?.(this.token);
      unregister();
    });
    const unregister = registerApplicationProcessCleanup(() => this.stop());
    activeOwners.add(this);
  }

  stop(): Promise<void> {
    this.stopping = true;
    return this.shutdown.request();
  }
  ready(): Promise<void> { return this.initialCapture; }
  get stopRequested(): boolean { return this.stopping; }

  private async capture() {
    if (this.capturePromise) return this.capturePromise;
    const pending = this.captureOnce();
    this.capturePromise = pending;
    try {
      return await pending;
    } finally {
      if (this.capturePromise === pending) this.capturePromise = undefined;
    }
  }

  private async captureOnce() {
    if (!this.child.pid) return [];
    if (this.platform !== 'win32') {
      if (!this.unix.captureOwnedGroups) throw new Error('Process ownership discovery is unavailable');
      if (!this.unixRootCaptured && !this.exited && this.unix.captureChildProcess) {
        const root = await this.unix.captureChildProcess(this.child.pid, this.token, () => !this.exited);
        if (root && !this.exited) this.unixRootCaptured = true;
      }
      return this.unix.captureOwnedGroups(this.token);
    }
    if (!this.windowsRoot) {
      const root = await this.windows.captureProcess(this.child.pid);
      // Only the live ChildProcess handle establishes the launch root. A PID
      // encountered after exit may already refer to an unrelated process.
      if (root && !this.exited) {
        this.windowsRoot = root;
        this.windowsMembers.set(root.pid, root);
      } else if (!this.windowsRoot) {
        throw new Error('Windows launch identity has not been confirmed');
      }
    }
    for (const identity of [...this.windowsMembers.values()]) {
      if (!await this.windows.isProcessAlive(identity)) continue;
      for (const descendant of await this.windows.captureDescendants(identity.pid)) {
        const previous = this.windowsMembers.get(descendant.pid);
        if (!previous || previous.birthMarker === descendant.birthMarker) {
          this.windowsMembers.set(descendant.pid, descendant);
        }
      }
    }
    return [];
  }

  private async signal(signal: NodeJS.Signals): Promise<boolean> {
    const groups = await this.capture();
    if (this.platform === 'win32') {
      for (const identity of [...this.windowsMembers.values()].reverse()) {
        if (await this.windows.isProcessAlive(identity)) await this.windows.terminateTree(identity.pid);
      }
    } else {
      if (this.exited && groups.length === 0) return true;
      await Promise.all(groups.map((group) => this.unix.signalProcessGroup(group, signal)));
    }
    return false;
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      const groups = await this.capture();
      const alive = this.platform === 'win32'
        ? (await Promise.all([...this.windowsMembers.values()].map((identity) => this.windows.isProcessAlive(identity)))).some(Boolean)
        : (await Promise.all(groups.map((group) => this.unix.isProcessGroupAlive(group)))).some(Boolean);
      if (this.exited && !alive) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return false;
  }
}

const WINDOWS_COMMAND_WRAPPER = String.raw`
const {spawn} = require('node:child_process');
process.on('message', message => {
  if (message?.type !== 'start') return;
  const child = spawn(message.command, message.args, {stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true});
  child.once('error', error => process.send({type:'command-exit',code:1,error:error.message}));
  child.once('exit', (code,signal) => process.send({type:'command-exit',code,signal}));
});
`;

export type OwnedCommandProcess = ChildProcess & {
  owner: ChildProcessOwner;
  commandResult?: { code: number | null; signal: NodeJS.Signals | null; error?: string };
};

/** Windows keeps a launch wrapper alive until its verified tree is reaped. */
export function spawnOwnedProcess(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; graceMs?: number; platform?: NodeJS.Platform; windows?: WindowsProcessTreeAdapter }): OwnedCommandProcess {
  assertApplicationProcessStartAllowed();
  const token = randomUUID();
  const platform = options.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const child = spawn(isWindows ? process.execPath : command, isWindows ? ['-e', WINDOWS_COMMAND_WRAPPER] : args, {
    cwd: options.cwd,
    env: { ...(options.env ?? process.env), [PROCESS_IDENTITY_ENV]: token },
    detached: !isWindows,
    stdio: isWindows ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  }) as OwnedCommandProcess;
  const owner = new OwnedChildProcess(child, token, { graceMs: options.graceMs, platform, windows: options.windows });
  child.owner = owner;
  if (isWindows) {
    child.on('message', (message: unknown) => {
      const result = message as { type?: string; code: number | null; signal?: NodeJS.Signals; error?: string };
      if (result?.type !== 'command-exit') return;
      child.commandResult = { code: result.code, signal: result.signal ?? null, error: result.error };
      void owner.stop();
    });
    void owner.ready().then(() => {
      assertApplicationProcessStartAllowed();
      if (!owner.stopRequested && child.connected) child.send!({ type: 'start', command, args });
    }).catch(() => owner.stop());
  }
  return child;
}

export interface OwnedCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer?: number;
  signal?: AbortSignal;
}

/** execFile-like text command whose timeout also reclaims hooks and helpers. */
export function runOwnedCommand(command: string, args: string[], options: OwnedCommandOptions): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) return Promise.reject(Object.assign(new Error(`${command} was cancelled`), { code: 'ABORT_ERR' }));
  const child = spawnOwnedProcess(command, args, options);
  const owner = child.owner;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let failure: Error | undefined;
    let finishing = false;
    const closed = new Promise<void>((done) => child.once('close', () => done()));
    const timer = options.timeout > 0 ? setTimeout(() => {
      failure = Object.assign(new Error(`${command} timed out`), { code: 'ETIMEDOUT' });
      void finish();
    }, options.timeout) : undefined;
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      await owner.stop();
      await closed;
      const code = child.commandResult?.code ?? child.exitCode;
      if (!failure && code !== 0) {
        failure = Object.assign(new Error(child.commandResult?.error ?? `${command} exited with code ${code}`), { code, signal: child.commandResult?.signal ?? child.signalCode });
      }
      if (failure) reject(Object.assign(failure, { stdout, stderr }));
      else resolve({ stdout, stderr });
    };
    const abort = () => {
      failure = Object.assign(new Error(`${command} was cancelled`), { code: 'ABORT_ERR' });
      void finish();
    };
    const append = (kind: 'stdout' | 'stderr', data: string) => {
      outputBytes += Buffer.byteLength(data);
      if (outputBytes > (options.maxBuffer ?? 10 * 1024 * 1024)) {
        failure = Object.assign(new Error(`${command} output exceeded its limit`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        void finish();
        return;
      }
      if (kind === 'stdout') stdout += data;
      else stderr += data;
    };
    child.stdout!.setEncoding('utf8').on('data', (data: string) => append('stdout', data));
    child.stderr!.setEncoding('utf8').on('data', (data: string) => append('stderr', data));
    child.once('error', (error) => { failure = error; void finish(); });
    child.once('exit', () => { void finish(); });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
