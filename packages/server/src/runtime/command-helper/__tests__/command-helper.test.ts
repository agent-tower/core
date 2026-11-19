import { createHook } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runOwnedCommand, runOwnedCommandInProcess, shutdownOwnedChildProcesses, type OwnedCommandOptions } from '../../../utils/owned-child-process.js';
import { recycleFixture, reportRssCommand } from './recycle-fixture.js';
import { readRuntimeCounters } from '../../runtime-metrics.js';
import { resolveScopeHelper } from '../../process-scope/scope-helper.js';
import {
  CommandHelperClient,
  getCommandHelperStatus,
  getRunningCommandHelper,
  isCommandHelperEnabled,
  isCommandHelperRunning,
  onCommandHelperAvailabilityChange,
  parseCommandHelperMode,
  startCommandHelper,
  stopCommandHelper,
  type StartCommandHelperOptions,
} from '../client.js';
import {
  COMMAND_HELPER_EXITED,
  COMMAND_HELPER_PROCESS_TITLE,
  COMMAND_HELPER_UNRESPONSIVE,
  deserializeCommandError,
  serializeCommandError,
} from '../protocol.js';

const node = process.execPath;
const posix = process.platform !== 'win32';
const linux = process.platform === 'linux';
const supervisedScopes = linux && resolveScopeHelper() !== null;
const temporaryDirectories: string[] = [];
/** Command fixtures, killed after each test if still alive. */
const fixturePids = new Set<number>();
/** Helpers started through the module API; they outlive single tests and are stopped by stopCommandHelper(). */
const helperPids = new Set<number>();
const quietLog = vi.fn();

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-command-helper-test-'));
  temporaryDirectories.push(dir);
  return dir;
}

async function readPid(file: string): Promise<number> {
  await vi.waitFor(() => expect(fs.existsSync(file) && fs.readFileSync(file, 'utf8').length > 0).toBe(true), { timeout: 10_000 });
  const pid = Number(fs.readFileSync(file, 'utf8'));
  fixturePids.add(pid);
  return pid;
}

/** A command that records its pid, then idles until stopped. */
function idleCommand(pidFile: string): [string, string[]] {
  return [node, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`]];
}

async function startHelper(options: StartCommandHelperOptions = {}): Promise<number> {
  const started = await startCommandHelper({ mode: 'on', log: quietLog, ...options });
  expect(started).toBe(true);
  const pid = getCommandHelperStatus().pid!;
  helperPids.add(pid);
  return pid;
}

/** A helper whose commands run without the scope supervisor (compatibility backend). */
async function startUnsupervisedHelper(options: StartCommandHelperOptions = {}): Promise<number> {
  const previous = process.env.AGENT_TOWER_PROCESS_SCOPE;
  process.env.AGENT_TOWER_PROCESS_SCOPE = 'compat';
  try {
    const pid = await startHelper(options);
    expect(getCommandHelperStatus().supervisedScopes).toBe(false);
    return pid;
  } finally {
    if (previous === undefined) delete process.env.AGENT_TOWER_PROCESS_SCOPE;
    else process.env.AGENT_TOWER_PROCESS_SCOPE = previous;
  }
}

type Settled =
  | { ok: true; value: unknown }
  | { ok: false; error: { class: string; name: string; message: string; properties: Record<string, unknown> } };

async function settle(promise: Promise<unknown>): Promise<Settled> {
  try {
    return { ok: true, value: await promise };
  } catch (caught) {
    const error = caught as Error;
    return { ok: false, error: { class: error.constructor.name, name: error.name, message: error.message, properties: { ...error } } };
  }
}

afterEach(() => {
  for (const pid of fixturePids) {
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* own fixture already exited */ } }
  }
  fixturePids.clear();
  for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  quietLog.mockClear();
});

afterAll(async () => {
  await stopCommandHelper();
  // Only reached when a test failed before its helper was stopped.
  for (const pid of helperPids) {
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
  }
});

describe('command helper results match in-process execution', () => {
  afterAll(async () => { await stopCommandHelper(); });

  interface Scenario {
    name: string;
    command: string;
    args: string[];
    options: (dir: string) => OwnedCommandOptions;
    skip?: boolean;
  }

  const scenarios: Scenario[] = [
    {
      name: 'success with stdout and stderr',
      command: node,
      args: ['-e', 'process.stdout.write("out ✓ 中文");process.stderr.write("err")'],
      options: () => ({ timeout: 10_000 }),
    },
    {
      name: 'non-zero exit',
      command: node,
      args: ['-e', 'process.stdout.write("partial");process.stderr.write("failed");process.exit(3)'],
      options: () => ({ timeout: 10_000 }),
    },
    {
      name: 'killed by a signal',
      command: node,
      args: ['-e', 'process.kill(process.pid,"SIGKILL")'],
      options: () => ({ timeout: 10_000 }),
      skip: !posix,
    },
    {
      name: 'missing executable',
      command: 'agent-tower-missing-executable-7d1f',
      args: ['--version'],
      options: () => ({ timeout: 10_000 }),
    },
    {
      name: 'timeout',
      command: node,
      args: ['-e', 'setInterval(()=>{},1000)'],
      options: () => ({ timeout: 400 }),
    },
    {
      name: 'output limit',
      command: node,
      args: ['-e', 'process.stdout.write("x".repeat(4096))'],
      options: () => ({ timeout: 10_000, maxBuffer: 1024 }),
    },
    {
      name: 'large multi-byte output',
      command: node,
      args: ['-e', 'process.stdout.write("é中".repeat(400000))'],
      options: () => ({ timeout: 20_000 }),
    },
    {
      name: 'working directory and environment from the caller',
      command: node,
      args: ['-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),value:process.env.AGENT_TOWER_HELPER_TEST_VALUE??null}))'],
      options: (dir) => ({ timeout: 10_000, cwd: dir, env: { ...process.env, AGENT_TOWER_HELPER_TEST_VALUE: 'from-caller' } }),
    },
    {
      name: 'default working directory',
      command: node,
      args: ['-e', 'process.stdout.write(process.cwd())'],
      options: () => ({ timeout: 10_000 }),
    },
  ];
  const active = scenarios.filter((scenario) => !scenario.skip);

  it('returns identical results and errors through the helper', async () => {
    const dir = fs.realpathSync(directory());
    const run = async () => {
      const results: Settled[] = [];
      for (const scenario of active) results.push(await settle(runOwnedCommand(scenario.command, scenario.args, scenario.options(dir))));
      return results;
    };

    expect(getRunningCommandHelper()).toBeNull();
    const before = readRuntimeCounters();
    const inProcess = await run();
    await startHelper();
    const middle = readRuntimeCounters();
    const viaHelper = await run();
    const after = readRuntimeCounters();

    expect(middle.commandsInProcess - before.commandsInProcess).toBe(active.length);
    expect(after.commandsViaHelper - middle.commandsViaHelper).toBe(active.length);
    expect(after.commandsInProcess - middle.commandsInProcess).toBe(0);
    for (const [index, scenario] of active.entries()) {
      expect({ scenario: scenario.name, result: viaHelper[index] }).toEqual({ scenario: scenario.name, result: inProcess[index] });
    }

    // The shared results are the documented ones, not merely equal.
    const byName = new Map(active.map((scenario, index) => [scenario.name, inProcess[index]!]));
    expect(byName.get('success with stdout and stderr')).toEqual({ ok: true, value: { stdout: 'out ✓ 中文', stderr: 'err' } });
    expect(byName.get('non-zero exit')).toMatchObject({ ok: false, error: { properties: { code: 3, signal: null, stdout: 'partial', stderr: 'failed' } } });
    expect(byName.get('missing executable')).toMatchObject({ ok: false, error: { properties: { code: 'ENOENT', syscall: 'spawn agent-tower-missing-executable-7d1f' } } });
    expect(byName.get('timeout')).toMatchObject({ ok: false, error: { message: `${node} timed out`, properties: { code: 'ETIMEDOUT', stdout: '', stderr: '' } } });
    expect(byName.get('output limit')).toMatchObject({ ok: false, error: { properties: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' } } });
    expect((byName.get('large multi-byte output') as { value: { stdout: string } }).value.stdout).toBe('é中'.repeat(400000));
    expect(byName.get('working directory and environment from the caller')).toEqual({ ok: true, value: { stdout: JSON.stringify({ cwd: dir, value: 'from-caller' }), stderr: '' } });
    expect(byName.get('default working directory')).toEqual({ ok: true, value: { stdout: process.cwd(), stderr: '' } });
    if (posix) {
      expect(byName.get('killed by a signal')).toMatchObject({ ok: false, error: { properties: { signal: 'SIGKILL' } } });
    }
  }, 120_000);
});

describe('command helper process', () => {
  let helperPid = 0;
  beforeAll(async () => { helperPid = await startHelper(); }, 60_000);
  afterAll(async () => { await stopCommandHelper(); }, 60_000);

  it('starts no child process in the calling process while the helper runs', async () => {
    const started: string[] = [];
    const hook = createHook({ init(_id, type) { if (type === 'PROCESSWRAP') started.push(type); } });
    hook.enable();
    try {
      // Positive control: the hook sees a child started by this process.
      await runOwnedCommandInProcess(node, ['-e', ''], { timeout: 10_000 });
      expect(started.length).toBeGreaterThan(0);
      started.length = 0;

      const before = readRuntimeCounters();
      const ancestry = 'const fs=require("node:fs");const chain=[];let pid=process.ppid;'
        + 'for(let i=0;i<8&&pid>1;i++){chain.push(pid);const stat=fs.readFileSync("/proc/"+pid+"/stat","utf8");pid=Number(stat.slice(stat.lastIndexOf(")")+2).split(" ")[1]);}'
        + 'process.stdout.write(JSON.stringify(chain))';
      const { stdout } = await runOwnedCommand(node, ['-e', linux ? ancestry : 'process.stdout.write("[]")'], { timeout: 10_000 });
      await runOwnedCommand('git', ['--version'], { timeout: 10_000 });
      expect(started).toEqual([]);
      const after = readRuntimeCounters();
      expect(after.commandsViaHelper - before.commandsViaHelper).toBe(2);
      expect(after.commandsInProcess - before.commandsInProcess).toBe(0);

      if (linux) {
        const chain = JSON.parse(stdout) as number[];
        // The command descends from the helper, and this process is only the helper's parent.
        expect(chain[0]).not.toBe(process.pid);
        expect(chain).toContain(helperPid);
        expect(chain.indexOf(process.pid)).toBe(chain.indexOf(helperPid) + 1);
      }
    } finally {
      hook.disable();
    }
  }, 30_000);

  it('sends the current environment of the caller with every request', async () => {
    process.env.AGENT_TOWER_HELPER_LATE_VALUE = 'set-after-helper-start';
    try {
      const { stdout } = await runOwnedCommand(node, ['-e', 'process.stdout.write(process.env.AGENT_TOWER_HELPER_LATE_VALUE??"missing")'], { timeout: 10_000 });
      expect(stdout).toBe('set-after-helper-start');
      const { stdout: withoutValue } = await runOwnedCommand(node, ['-e', 'process.stdout.write(process.env.AGENT_TOWER_HELPER_LATE_VALUE??"missing")'], {
        timeout: 10_000,
        env: { PATH: process.env.PATH, AGENT_TOWER_HELPER_LATE_VALUE: undefined },
      });
      expect(withoutValue).toBe('missing');
    } finally {
      delete process.env.AGENT_TOWER_HELPER_LATE_VALUE;
    }
  }, 30_000);

  it.skipIf(!posix)('stops an aborted command through the owner rules before rejecting', async () => {
    const dir = directory();
    const pidFile = path.join(dir, 'command.pid');
    const controller = new AbortController();
    const pending = runOwnedCommand(...idleCommand(pidFile), { timeout: 30_000, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR', message: `${node} was cancelled`, stdout: '', stderr: '' });
    const pid = await readPid(pidFile);
    controller.abort();
    await rejected;
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it('rejects an already aborted signal without contacting the helper', async () => {
    const controller = new AbortController();
    controller.abort();
    const before = readRuntimeCounters();
    await expect(runOwnedCommand('git', ['status'], { timeout: 10_000, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ABORT_ERR', message: 'git was cancelled' });
    expect(readRuntimeCounters()).toEqual(before);
    expect(getCommandHelperStatus().pendingCommands).toBe(0);
  });

  it('has a recognisable process title and reports its memory', () => {
    const status = getCommandHelperStatus();
    expect(status).toMatchObject({ state: 'running', pid: helperPid });
    expect(status.rssBytes).toBeGreaterThan(0);
    if (linux) {
      const cmdline = fs.readFileSync(`/proc/${helperPid}/cmdline`, 'utf8');
      expect(cmdline.startsWith(COMMAND_HELPER_PROCESS_TITLE)).toBe(true);
    }
  });
});

describe('command helper failures and shutdown', () => {
  afterEach(async () => { await stopCommandHelper(); }, 60_000);

  it.skipIf(!posix)('rejects a running command with a distinct code when the helper dies, never re-runs it, and restarts', async () => {
    const dir = directory();
    const pidFile = path.join(dir, 'command.pid');
    const runs = path.join(dir, 'runs.log');
    const restartsBefore = readRuntimeCounters().helperRestarts;
    const helperPid = await startHelper({ restartDelaysMs: [1_500] });
    const pending = runOwnedCommand(node, ['-e', `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(runs)},'run\\n');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`], { timeout: 60_000 });
    const rejected = expect(pending).rejects.toMatchObject({ code: COMMAND_HELPER_EXITED, message: expect.stringContaining('not re-run') });
    const commandPid = await readPid(pidFile);

    process.kill(helperPid, 'SIGKILL');
    await rejected;
    expect(getRunningCommandHelper()).toBeNull();
    // While the helper is down, commands run in this process.
    const inProcessBefore = readRuntimeCounters().commandsInProcess;
    await expect(runOwnedCommand(node, ['-e', 'process.stdout.write("fallback")'], { timeout: 10_000 })).resolves.toEqual({ stdout: 'fallback', stderr: '' });
    expect(readRuntimeCounters().commandsInProcess).toBe(inProcessBefore + 1);
    if (supervisedScopes) {
      // The scope supervisor stops its command when its parent (the helper) dies.
      await vi.waitFor(() => expect(alive(commandPid)).toBe(false), { timeout: 10_000 });
    }

    await vi.waitFor(() => expect(getCommandHelperStatus().state).toBe('running'), { timeout: 30_000 });
    const restartedPid = getCommandHelperStatus().pid!;
    helperPids.add(restartedPid);
    expect(restartedPid).not.toBe(helperPid);
    expect(readRuntimeCounters().helperRestarts).toBe(restartsBefore + 1);
    await expect(runOwnedCommand(node, ['-e', 'process.stdout.write("again")'], { timeout: 10_000 })).resolves.toEqual({ stdout: 'again', stderr: '' });
    expect(fs.readFileSync(runs, 'utf8')).toBe('run\n');
    expect(quietLog).toHaveBeenCalledWith('warn', expect.stringContaining('1 running command(s) were rejected and not re-run'));
  }, 90_000);

  it('stops restarting after repeated failures and logs that once', async () => {
    const dir = directory();
    const crashing = path.join(dir, 'crashing-helper.mjs');
    fs.writeFileSync(crashing, 'process.exit(7);\n');
    const restartsBefore = readRuntimeCounters().helperRestarts;
    const started = await startCommandHelper({
      mode: 'on', log: quietLog, entry: { modulePath: crashing, execArgv: [] }, restartDelaysMs: [20], maxConsecutiveFailures: 3,
    });
    expect(started).toBe(false);
    expect(getCommandHelperStatus().state).toBe('failed');
    expect(readRuntimeCounters().helperRestarts).toBe(restartsBefore + 2);
    const errors = quietLog.mock.calls.filter(([level]) => level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]![1]).toContain('Stopped restarting after 3 consecutive failures');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(quietLog.mock.calls.filter(([level]) => level === 'error')).toHaveLength(1);
    await expect(runOwnedCommand(node, ['-e', 'process.stdout.write("in-process")'], { timeout: 10_000 })).resolves.toEqual({ stdout: 'in-process', stderr: '' });
  }, 60_000);

  it('kills a helper that never reports ready, which has received no command', async () => {
    const dir = directory();
    const silent = path.join(dir, 'silent-helper.mjs');
    const pidFile = path.join(dir, 'silent.pid');
    fs.writeFileSync(silent, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`);
    const started = await startCommandHelper({
      mode: 'on', log: quietLog, entry: { modulePath: silent, execArgv: [] }, readyTimeoutMs: 1_000, maxConsecutiveFailures: 1,
    });
    expect(started).toBe(false);
    const pid = await readPid(pidFile);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 });
    expect(quietLog).toHaveBeenCalledWith('warn', expect.stringContaining('did not report ready'));
  }, 60_000);

  it.skipIf(!posix)('stops a running command on shutdown, as an in-process shutdown does, and exits', async () => {
    const dir = directory();
    const shutdownOutcome = async (stop: () => Promise<void>, pidFile: string) => {
      const pending = settle(runOwnedCommand(...idleCommand(pidFile), { timeout: 60_000 }));
      const pid = await readPid(pidFile);
      await stop();
      const outcome = await pending;
      expect(alive(pid)).toBe(false);
      return outcome;
    };

    const inProcess = await shutdownOutcome(() => shutdownOwnedChildProcesses(), path.join(dir, 'in-process.pid'));
    const helperPid = await startHelper();
    const viaHelper = await shutdownOutcome(() => stopCommandHelper(), path.join(dir, 'helper.pid'));

    expect(viaHelper).toEqual(inProcess);
    expect(inProcess).toMatchObject({ ok: false, error: { properties: { code: null, signal: 'SIGTERM' } } });
    expect(alive(helperPid)).toBe(false);
    expect(getCommandHelperStatus()).toMatchObject({ state: 'stopped', pendingCommands: 0 });
    expect(getRunningCommandHelper()).toBeNull();
  }, 60_000);

  it.skipIf(!posix)('rejects a command at its deadline when the helper stops answering, replaces the helper, and later commands work', async () => {
    const dir = directory();
    const pidFile = path.join(dir, 'running.pid');
    const restartsBefore = readRuntimeCounters().helperRestarts;
    const helperPid = await startHelper({ resultGraceMs: 600, terminateGraceMs: 400, restartDelaysMs: [100] });
    // Started before the freeze, without a timeout: it has no deadline of its own.
    const running = settle(runOwnedCommand(...idleCommand(pidFile), { timeout: 0 }));
    const runningPid = await readPid(pidFile);

    process.kill(helperPid, 'SIGSTOP');
    const sentAt = Date.now();
    await expect(runOwnedCommand('git', ['--version'], { timeout: 300 }))
      .rejects.toMatchObject({ code: COMMAND_HELPER_UNRESPONSIVE, message: expect.stringContaining('not re-run') });
    const waited = Date.now() - sentAt;
    expect(waited).toBeGreaterThanOrEqual(850);
    expect(waited).toBeLessThan(5_000);
    // The frozen helper takes no new command meanwhile.
    expect(getRunningCommandHelper()).toBeNull();

    // SIGTERM stays pending in a stopped process; SIGKILL follows after the grace.
    expect(await running).toMatchObject({ ok: false, error: { properties: { code: COMMAND_HELPER_EXITED } } });
    await vi.waitFor(() => expect(alive(helperPid)).toBe(false), { timeout: 10_000 });
    if (supervisedScopes) await vi.waitFor(() => expect(alive(runningPid)).toBe(false), { timeout: 10_000 });

    await vi.waitFor(() => expect(getCommandHelperStatus().state).toBe('running'), { timeout: 30_000 });
    const replacement = getCommandHelperStatus().pid!;
    helperPids.add(replacement);
    expect(replacement).not.toBe(helperPid);
    expect(readRuntimeCounters().helperRestarts).toBe(restartsBefore + 1);
    await expect(runOwnedCommand(node, ['-e', 'process.stdout.write("works")'], { timeout: 10_000 })).resolves.toEqual({ stdout: 'works', stderr: '' });
    expect(quietLog).toHaveBeenCalledWith('error', expect.stringMatching(/did not answer git within \d+ ms; stopping it/));
  }, 90_000);

  it.skipIf(!posix)('arms the deadline when a command without timeout is aborted, and warns about orphans without a scope supervisor', async () => {
    const helperPid = await startUnsupervisedHelper({ resultGraceMs: 400, terminateGraceMs: 300, restartDelaysMs: [100] });
    process.kill(helperPid, 'SIGSTOP');
    const controller = new AbortController();
    const pending = runOwnedCommand('git', ['--version'], { timeout: 0, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: COMMAND_HELPER_UNRESPONSIVE });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const abortedAt = Date.now();
    controller.abort();
    await rejected;
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(350);
    expect(quietLog).toHaveBeenCalledWith('error', expect.stringContaining('commands still running in it may be orphaned'));
    await vi.waitFor(() => expect(alive(helperPid)).toBe(false), { timeout: 10_000 });
    await vi.waitFor(() => expect(getCommandHelperStatus().state).toBe('running'), { timeout: 30_000 });
    helperPids.add(getCommandHelperStatus().pid!);
  }, 90_000);

  it.skipIf(!supervisedScopes)('bounds stop() for a silent helper by killing it when scopes are supervised, leaving no process behind', async () => {
    const dir = directory();
    const pidFile = path.join(dir, 'running.pid');
    const helperPid = await startHelper({ stopTimeoutMs: 600 });
    const running = settle(runOwnedCommand(...idleCommand(pidFile), { timeout: 0 }));
    const runningPid = await readPid(pidFile);
    process.kill(helperPid, 'SIGSTOP');

    const stoppingAt = Date.now();
    // Concurrent callers (application shutdown paths) share one bounded wait.
    await Promise.all([stopCommandHelper(), stopCommandHelper()]);
    const elapsed = Date.now() - stoppingAt;
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(5_000);
    expect(alive(helperPid)).toBe(false);
    expect(await running).toMatchObject({ ok: false, error: { properties: { code: COMMAND_HELPER_EXITED } } });
    // The scope supervisor stops the command tree on its parent's death.
    await vi.waitFor(() => expect(alive(runningPid)).toBe(false), { timeout: 10_000 });
    expect(getCommandHelperStatus()).toMatchObject({ state: 'stopped', pendingCommands: 0 });
    const kills = quietLog.mock.calls.filter(([level, message]) => level === 'warn' && String(message).includes('did not exit within 600 ms of the stop request; killing it'));
    expect(kills).toHaveLength(1);
  }, 60_000);

  it.skipIf(!posix)('reports pending cleanup when stop() cannot confirm a silent helper without a scope supervisor', async () => {
    const helperPid = await startUnsupervisedHelper({ stopTimeoutMs: 400 });
    process.kill(helperPid, 'SIGSTOP');
    const [first, second] = await Promise.allSettled([stopCommandHelper(), stopCommandHelper()]);
    expect(first).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('child process tree cleanup remains pending') } });
    // Concurrent callers share the wait and see the same failure.
    expect((second as PromiseRejectedResult).reason).toBe((first as PromiseRejectedResult).reason);
    // Not killed: that could orphan its commands. A retry waits again.
    expect(alive(helperPid)).toBe(true);
    await expect(stopCommandHelper()).rejects.toThrow('cleanup remains pending');
    process.kill(helperPid, 'SIGKILL');
    await stopCommandHelper();
    expect(alive(helperPid)).toBe(false);
    expect(getCommandHelperStatus().state).toBe('stopped');
  }, 60_000);

  it.skipIf(!posix).each([1, 2])('cleans up %i helpers and their command trees when the parent is killed with SIGKILL', async (generations) => {
    const dir = directory();
    const here = path.dirname(fileURLToPath(import.meta.url));
    const clientUrl = pathToFileURL(path.resolve(here, '../client.ts')).href;
    const ownedUrl = pathToFileURL(path.resolve(here, '../../../utils/owned-child-process.ts')).href;
    const options = { mode: 'on', entry: recycleFixture(dir).entry, recycleReports: 1, recycleRssMb: 4000 };
    const script = [
      `import { getCommandHelperStatus, startCommandHelper, onCommandHelperPlacementChange } from ${JSON.stringify(clientUrl)};`,
      `import { runOwnedCommand } from ${JSON.stringify(ownedUrl)};`,
      `if (!await startCommandHelper({ ...${JSON.stringify(options)}, log: () => undefined })) process.exit(2);`,
    ];
    for (let index = 0; index < generations; index++) {
      if (index > 0) script.push(
        'const switched = new Promise(resolve => { const off = onCommandHelperPlacementChange(() => { off(); resolve(); }); });',
        `await runOwnedCommand(...${JSON.stringify(reportRssCommand(5000))}); await switched;`,
      );
      // Only the owner's escalation can stop the detached, signal-resistant descendant.
      const member = `process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, 'descendant-' + index))}, String(process.pid));setInterval(()=>{},1000)`;
      const root = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(member)}],{detached:true,stdio:'ignore'});`
        + `require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, 'root-' + index))}, JSON.stringify([process.pid,process.ppid]));setInterval(()=>{},1000)`;
      script.push(
        `runOwnedCommand(process.execPath, ['-e', ${JSON.stringify(root)}], { timeout: 120_000 }).catch(() => undefined);`,
        `process.stdout.write(String(getCommandHelperStatus().pid) + '\\n');`,
      );
    }
    const parentScript = path.join(dir, 'parent.mts');
    fs.writeFileSync(parentScript, script.join('\n'));
    const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const parent = spawn(node, ['--import', tsxLoader, parentScript], { stdio: ['ignore', 'pipe', 'inherit'] });
    fixturePids.add(parent.pid!);
    let output = '';
    parent.stdout!.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    await vi.waitFor(() => expect(output.trim().split(/\s+/).filter(Boolean)).toHaveLength(generations), { timeout: 30_000 });
    const helpers = output.trim().split(/\s+/).map(Number);
    expect(new Set(helpers).size).toBe(generations);
    const tree = [...helpers];
    for (const [index, helper] of helpers.entries()) {
      fixturePids.add(helper);
      tree.push(await readPid(path.join(dir, 'descendant-' + index)));
      const [rootPid, rootParentPid] = JSON.parse(fs.readFileSync(path.join(dir, 'root-' + index), 'utf8')) as [number, number];
      fixturePids.add(rootPid);
      tree.push(rootPid, rootParentPid);
      if (supervisedScopes) expect(rootParentPid).not.toBe(helper);
    }
    expect(tree.every(alive)).toBe(true);
    const killedAt = Date.now();
    parent.kill('SIGKILL');
    await vi.waitFor(() => expect(tree.filter(alive)).toEqual([]), { timeout: 10_000, interval: 50 });
    const elapsedMs = Date.now() - killedAt;
    console.info(`[command-helper test] parent SIGKILL -> ${generations} helper(s) and command trees gone in ${elapsedMs} ms`);
    expect(elapsedMs).toBeLessThan(6_000);
  }, 90_000);

  it('reports whether commands go to the helper and notifies each change', async () => {
    const events: Array<{ running: boolean; state: string }> = [];
    const unsubscribe = onCommandHelperAvailabilityChange((running, status) => { events.push({ running, state: status.state }); });
    try {
      expect(isCommandHelperRunning()).toBe(false);
      const helperPid = await startHelper({ restartDelaysMs: [200] });
      expect(isCommandHelperRunning()).toBe(true);
      expect(events).toEqual([{ running: true, state: 'running' }]);

      process.kill(helperPid, 'SIGKILL');
      await vi.waitFor(() => expect(events).toHaveLength(3), { timeout: 30_000 });
      expect(events[1]).toEqual({ running: false, state: expect.stringMatching(/^(draining|restarting)$/) });
      expect(events[2]).toEqual({ running: true, state: 'running' });
      helperPids.add(getCommandHelperStatus().pid!);

      await stopCommandHelper();
      expect(isCommandHelperRunning()).toBe(false);
      expect(events.slice(3)).toEqual([{ running: false, state: 'stopping' }]);
    } finally {
      unsubscribe();
    }
    await startHelper();
    await stopCommandHelper();
    expect(events).toHaveLength(4);
  }, 90_000);
});

describe('command helper switch', () => {
  it('reads AGENT_TOWER_COMMAND_HELPER', () => {
    expect(parseCommandHelperMode(undefined)).toEqual({ mode: 'auto', valid: true });
    expect(parseCommandHelperMode(' ON ')).toEqual({ mode: 'on', valid: true });
    expect(parseCommandHelperMode('off')).toEqual({ mode: 'off', valid: true });
    expect(parseCommandHelperMode('yes')).toEqual({ mode: 'auto', valid: false });
  });

  it('enables auto on Linux only', () => {
    expect(isCommandHelperEnabled('auto', 'linux')).toBe(true);
    expect(isCommandHelperEnabled('auto', 'darwin')).toBe(false);
    expect(isCommandHelperEnabled('auto', 'win32')).toBe(false);
    expect(isCommandHelperEnabled('on', 'darwin')).toBe(true);
    expect(isCommandHelperEnabled('off', 'linux')).toBe(false);
  });

  it('never forks a helper once the client was stopped', async () => {
    const client = new CommandHelperClient({ log: quietLog });
    await client.stop();
    expect(await client.start()).toBe(false);
    expect(client.status()).toMatchObject({ state: 'stopped', pendingCommands: 0 });
    expect(client.status().pid).toBeUndefined();
  });

  it('starts nothing when disabled, so commands run in the calling process', async () => {
    await expect(startCommandHelper({ mode: 'off' })).resolves.toBe(false);
    await expect(startCommandHelper({ mode: 'auto', platform: 'darwin' })).resolves.toBe(false);
    expect(getRunningCommandHelper()).toBeNull();
    expect(getCommandHelperStatus().state).not.toBe('running');
  });
});

describe('command error transfer', () => {
  it('keeps the class, message and own properties of an error', () => {
    const spawnError = Object.assign(new Error('spawn git ENOENT'), {
      errno: -2, code: 'ENOENT', syscall: 'spawn git', path: 'git', spawnargs: ['status'], stdout: '', stderr: '',
    });
    const copy = deserializeCommandError(structuredClone(serializeCommandError(spawnError)));
    expect(copy).toBeInstanceOf(Error);
    expect(copy.message).toBe('spawn git ENOENT');
    expect({ ...copy }).toEqual({ ...spawnError });

    const typeError = Object.assign(new TypeError('bad argument'), { code: 'ERR_INVALID_ARG_TYPE' });
    const typeCopy = deserializeCommandError(structuredClone(serializeCommandError(typeError)));
    expect(typeCopy).toBeInstanceOf(TypeError);
    expect(Object.keys(typeCopy)).toEqual(['code']);

    expect(deserializeCommandError(serializeCommandError('plain failure')).message).toBe('plain failure');
  });
});
