/**
 * Entry of the command helper process (see ./client.ts). The server forks it
 * at boot and sends it owned commands over IPC; it runs each one with the
 * in-process implementation, so the scope supervisor, the stop rules, the
 * timeout and the output limit are exactly those of `runOwnedCommand`.
 *
 * It also hosts the git state service (git/state/git-state-service.ts) when
 * the server asks for git state or a file's diff: the same code the server
 * runs when no helper is available, here with its git commands started by
 * this process.
 *
 * Keep the import graph small: no Prisma, no Fastify, no services. The test
 * `command-helper-imports.test.ts` guards this.
 *
 * Lifetime: the server stops it with a `shutdown` message. When the IPC
 * channel closes (the server died) it stops its running commands and exits.
 * SIGTERM stops it the same way. SIGINT and SIGHUP are ignored: a terminal
 * sends them to the whole process group, and the server then stops the
 * helper itself in order.
 */
import { WorkspaceGitStateService } from '../../git/state/git-state-service.js';
import { runOwnedCommandInProcess, shutdownOwnedChildProcesses } from '../../utils/owned-child-process.js';
import { beginApplicationProcessShutdown } from '../application-process-cleanup.js';
import { getDefaultProcessScopeRuntime } from '../process-scope/process-scope.js';
import {
  COMMAND_HELPER_EXITED,
  COMMAND_HELPER_PROCESS_TITLE,
  serializeCommandError,
  type GitDiffRequestMessage,
  type GitStateRequestMessage,
  type RegisterGitStateRequestMessage,
  type HelperToServerMessage,
  type RunCommandRequest,
  type ServerToHelperMessage,
} from './protocol.js';

const STATS_INTERVAL_MS = 30_000;

process.title = COMMAND_HELPER_PROCESS_TITLE;

interface RunningRequest {
  /** `git-state` covers state and diff requests: both are cancelled on shutdown and may be asked elsewhere. */
  kind: 'command' | 'git-state';
  controller: AbortController;
  reported: Promise<void>;
  /** The server cancelled it (as opposed to this helper shutting down). */
  cancelled: boolean;
}

const running = new Map<number, RunningRequest>();
let shutdownPromise: Promise<void> | undefined;
/** Created on the first git state request; one instance (one epoch) per helper process. */
let gitStateService: WorkspaceGitStateService | undefined;
let activityScheduled = false;

/** Coalesce counter increments in one turn; unchanged computations still report activity. */
function reportGitStateActivity(): void {
  if (activityScheduled || shutdownPromise) return;
  activityScheduled = true;
  setImmediate(() => {
    activityScheduled = false;
    if (!gitStateService || shutdownPromise) return;
    void send({
      type: 'git-state-activity',
      epoch: gitStateService.epoch,
      counters: gitStateService.readCounters(),
      registeredWorktrees: gitStateService.registeredCount,
      rssBytes: process.memoryUsage.rss(),
    });
  }).unref();
}

function getGitStateService(): WorkspaceGitStateService {
  gitStateService ??= new WorkspaceGitStateService({
    run: runOwnedCommandInProcess,
    onCounters: reportGitStateActivity,
    onRegisteredCount: reportGitStateActivity,
    onChange: (snapshot) => {
      if (!shutdownPromise) void send({ type: 'git-state-changed', snapshot, counters: gitStateService!.readCounters() });
    },
  });
  return gitStateService;
}

function send(message: HelperToServerMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.connected || !process.send) {
      resolve();
      return;
    }
    try {
      process.send(message, undefined, undefined, () => resolve());
    } catch (error) {
      // Only a result can fail to serialize; report that instead of hanging the caller.
      if (message.type === 'result' || message.type === 'git-state-result' || message.type === 'git-diff-result') {
        void send({
          type: message.type,
          id: message.id,
          ok: false,
          error: serializeCommandError(Object.assign(new Error(`Command helper could not return the result: ${(error as Error).message}`), { code: 'ERR_COMMAND_HELPER_PROTOCOL' })),
        }).then(resolve);
        return;
      }
      resolve();
    }
  });
}

function track(id: number, kind: RunningRequest['kind']): { request: RunningRequest; reported: () => void } {
  let reported!: () => void;
  const request: RunningRequest = { kind, controller: new AbortController(), reported: new Promise<void>((resolve) => { reported = resolve; }), cancelled: false };
  running.set(id, request);
  return { request, reported };
}

async function computeGitState(message: GitStateRequestMessage | RegisterGitStateRequestMessage): Promise<void> {
  const { request, reported } = track(message.id, 'git-state');
  try {
    if (shutdownPromise) throw Object.assign(new Error('git state was not computed: the command helper is shutting down'), { code: COMMAND_HELPER_EXITED });
    const service = getGitStateService();
    const options = { signal: request.controller.signal };
    const result = await (message.type === 'git-state-register' ? service.register(message.request, options) : service.get(message.request, options));
    await send({ type: 'git-state-result', id: message.id, ok: true, result });
  } catch (error) {
    // Stopped because this helper is going away: the server may ask elsewhere.
    const reportedError = shutdownPromise && !request.cancelled
      ? Object.assign(new Error('git state was not computed: the command helper is shutting down'), { code: COMMAND_HELPER_EXITED })
      : error;
    await send({ type: 'git-state-result', id: message.id, ok: false, error: serializeCommandError(reportedError) });
  } finally {
    running.delete(message.id);
    reported();
  }
}

async function computeGitDiff(message: GitDiffRequestMessage): Promise<void> {
  const { request, reported } = track(message.id, 'git-state');
  try {
    if (shutdownPromise) throw Object.assign(new Error('git diff was not computed: the command helper is shutting down'), { code: COMMAND_HELPER_EXITED });
    const result = await getGitStateService().diff(message.request, { signal: request.controller.signal });
    await send({ type: 'git-diff-result', id: message.id, ok: true, result });
  } catch (error) {
    const reportedError = shutdownPromise && !request.cancelled
      ? Object.assign(new Error('git diff was not computed: the command helper is shutting down'), { code: COMMAND_HELPER_EXITED })
      : error;
    await send({ type: 'git-diff-result', id: message.id, ok: false, error: serializeCommandError(reportedError) });
  } finally {
    running.delete(message.id);
    reported();
  }
}

async function run(request: RunCommandRequest): Promise<void> {
  const { request: tracked, reported } = track(request.id, 'command');
  const controller = tracked.controller;
  try {
    const { stdout, stderr } = await runOwnedCommandInProcess(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      timeout: request.timeout,
      maxBuffer: request.maxBuffer,
      signal: controller.signal,
    });
    await send({ type: 'result', id: request.id, ok: true, stdout, stderr });
  } catch (error) {
    await send({ type: 'result', id: request.id, ok: false, error: serializeCommandError(error) });
  } finally {
    running.delete(request.id);
    reported();
  }
}

/**
 * Stops every running command through the owner stop rules (the same path as
 * the server's application shutdown), lets each request report its result,
 * then exits. Git state and diff requests are cancelled and answered with
 * `ERR_COMMAND_HELPER_EXITED`, so the server can ask elsewhere.
 */
function shutdown(reason: string, exitCode = 0): Promise<void> {
  shutdownPromise ??= (async () => {
    beginApplicationProcessShutdown();
    for (const request of running.values()) {
      if (request.kind === 'git-state') request.controller.abort();
    }
    // Includes background computations, which have no waiting IPC request.
    gitStateService?.dispose();
    if (reason !== 'shutdown request') await send({ type: 'closing', reason });
    try {
      await shutdownOwnedChildProcesses();
    } catch (error) {
      console.error('[command-helper] stopping running commands failed', error);
    }
    // Requests that arrive meanwhile are refused at once and report too.
    while (running.size > 0) {
      await Promise.all([...running.values()].map((command) => command.reported));
    }
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

if (!process.send) {
  console.error('[command-helper] must be started by the Agent Tower server over IPC');
  process.exit(1);
}

process.on('message', (value: unknown) => {
  if (!value || typeof value !== 'object') return;
  const message = value as ServerToHelperMessage;
  switch (message.type) {
    case 'run':
      void run(message);
      return;
    case 'git-state':
    case 'git-state-register':
      void computeGitState(message);
      return;
    case 'git-diff':
      void computeGitDiff(message);
      return;
    case 'git-state-retire':
      gitStateService?.retire();
      return;
    case 'git-state-unregister':
      gitStateService?.unregister(message.worktreePath);
      return;
    case 'git-state-invalidate':
      if (!shutdownPromise) gitStateService?.invalidate(message.worktreePath, message.trigger);
      return;
    case 'cancel': {
      const request = running.get(message.id);
      if (!request) return;
      request.cancelled = true;
      request.controller.abort();
      return;
    }
    case 'shutdown':
      void shutdown('shutdown request');
      return;
  }
});
process.on('disconnect', () => { void shutdown('server disconnected'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => undefined);
process.on('SIGHUP', () => undefined);
process.on('uncaughtException', (error) => {
  console.error('[command-helper] uncaught exception; stopping running commands and exiting', error);
  void shutdown('uncaught exception', 1);
});

const statsTimer = setInterval(() => {
  void send({ type: 'stats', rssBytes: process.memoryUsage.rss(), running: running.size });
}, STATS_INTERVAL_MS);
statsTimer.unref();

// Probe the scope supervisor now rather than inside the first command.
let supervisedScopes = false;
try {
  supervisedScopes = getDefaultProcessScopeRuntime() !== null;
} catch {
  // The first command probes again and falls back to the compatibility backend.
}

void send({ type: 'ready', pid: process.pid, rssBytes: process.memoryUsage.rss(), supervisedScopes });
