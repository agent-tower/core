import { createHook } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runOwnedCommand } from '../../../utils/owned-child-process.js';
import { readRuntimeCounters } from '../../runtime-metrics.js';
import { getCommandHelperStatus, onCommandHelperAvailabilityChange, startCommandHelper, stopCommandHelper, type StartCommandHelperOptions } from '../client.js';
import { COMMAND_HELPER_EXITED } from '../protocol.js';
import { recycleFixture, reportRssCommand } from './recycle-fixture.js';

const log = vi.fn();
let dir: string;
let fixture: ReturnType<typeof recycleFixture>;
const pid = () => getCommandHelperStatus().pid!;
const alive = (id: number) => { try { process.kill(id, 0); return true; } catch { return false; } };
const report = (mb: number) => runOwnedCommand(...reportRssCommand(mb));
const changedPid = (old: number) => vi.waitFor(() => { expect(pid()).not.toBe(old); expect(getCommandHelperStatus().state).toBe('running'); }, { timeout: 10_000 });
const start = (options: StartCommandHelperOptions = {}) => startCommandHelper({
  mode: 'on', entry: fixture.entry, recycleRssMb: 4000, log, ...options,
});
const waitFile = (file: string) => vi.waitFor(() => expect(fs.existsSync(file)).toBe(true), { timeout: 10_000 });

// The sample is sent before the command result, so every synchronous fork caused
// by it has happened by the time report() resolves.
async function forksDuringReport(mb = 5000): Promise<number> {
  let count = 0;
  const hook = createHook({ init(_id, type) { if (type === 'PROCESSWRAP') count++; } });
  hook.enable();
  try { await report(mb); } finally { hook.disable(); }
  return count;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-recycle-'));
  fixture = recycleFixture(dir);
  log.mockClear();
});
afterEach(async () => {
  try { await stopCommandHelper(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** The command records its actual helper ancestor and finishes when its file appears. */
function heldCommand(name: string) {
  const release = path.join(dir, name);
  const started = release + '.pid';
  const script = `
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(started)}, process.pid + '\\n');
    const ancestry = [];
    if (process.platform === 'linux') {
      let pid = process.ppid;
      while (pid > 1) {
        ancestry.push(pid);
        const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      }
    }
    const release = ${JSON.stringify(release)};
    const watcher = fs.watch(${JSON.stringify(dir)}, check);
    function check() {
      if (fs.existsSync(release)) { watcher.close(); process.stdout.write(JSON.stringify(ancestry)); }
    }
    check();
  `;
  const result = runOwnedCommand(process.execPath, ['-e', script], { timeout: 30_000 });
  void result.catch(() => undefined);
  return { result, started, finish: () => fs.writeFileSync(release, '') };
}

it('requires three consecutive high reports, keeps accepting commands while warming up, and drains their actual owner', async () => {
  expect(await start()).toBe(true);
  const initial = pid();
  const before = readRuntimeCounters();
  const availability = vi.fn();
  const off = onCommandHelperAvailabilityChange(availability);
  try {
    fs.writeFileSync(fixture.gate, '');
    for (const mb of [5000, 5000, 4000, 5000, 5000]) expect(await forksDuringReport(mb)).toBe(0);
    expect(fs.existsSync(fixture.candidate)).toBe(false);
    const old = heldCommand('old');
    await waitFile(old.started);
    expect(await forksDuringReport()).toBe(1);
    await waitFile(fixture.candidate);
    expect(pid()).toBe(initial);
    const during = heldCommand('during');
    await waitFile(during.started);
    fs.unlinkSync(fixture.gate);
    await changedPid(initial);
    const replacement = pid();
    const fresh = heldCommand('fresh');
    fresh.finish();
    during.finish();
    old.finish();
    for (const [command, owner] of [[old, initial], [during, initial], [fresh, replacement]] as const) {
      const { stdout } = await command.result;
      if (process.platform === 'linux') expect(JSON.parse(stdout)).toContain(owner);
      expect(fs.readFileSync(command.started, 'utf8').trim().split('\n')).toHaveLength(1);
    }
    await vi.waitFor(() => expect(alive(initial)).toBe(false), { timeout: 10_000 });
    expect(availability).not.toHaveBeenCalled();
    const after = readRuntimeCounters();
    expect(after.commandsViaHelper - before.commandsViaHelper).toBe(9);
    expect(after.commandsInProcess).toBe(before.commandsInProcess);
    expect(after.helperRestarts).toBe(before.helperRestarts);
    expect(after.helperRecycles - before.helperRecycles).toBe(1);
  } finally { off(); }
}, 45_000);

it('limits replacement attempts over time and honors a zero environment limit', async () => {
  const interval = 3_000;
  await start({ recycleReports: 1, recycleMinIntervalMs: interval });
  const initial = pid();
  await report(5000);
  await changedPid(initial);
  const at = performance.now();
  await vi.waitFor(() => expect(alive(initial)).toBe(false), { timeout: 10_000 });
  const next = pid();
  expect(await forksDuringReport()).toBe(0);
  expect(pid()).toBe(next);
  expect(readRuntimeCounters().helperRecycles).toBeGreaterThan(0);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, at + interval + 100 - performance.now())));
  expect(await forksDuringReport()).toBe(1);
  await changedPid(next);
  expect(performance.now() - at).toBeGreaterThanOrEqual(interval);
  await stopCommandHelper();

  vi.stubEnv('AGENT_TOWER_COMMAND_HELPER_RECYCLE_RSS_MB', '0');
  try {
    expect(await start({ recycleRssMb: undefined, recycleReports: 1 })).toBe(true);
    const disabled = pid();
    fs.writeFileSync(fixture.gate, '');
    await report(5000); await report(5000); expect(await forksDuringReport()).toBe(0);
    expect(pid()).toBe(disabled);
    expect(fs.existsSync(fixture.candidate)).toBe(false);
  } finally { vi.unstubAllEnvs(); }
}, 30_000);

it('keeps the serving helper on a candidate ready timeout and rate limits the next attempt', async () => {
  await start({ recycleReports: 1, readyTimeoutMs: 5_000, recycleMinIntervalMs: 60_000 });
  const initial = pid();
  const before = readRuntimeCounters();
  fs.writeFileSync(fixture.gate, '');
  await report(5000);
  await waitFile(fixture.candidate);
  const candidate = Number(fs.readFileSync(fixture.candidate, 'utf8'));
  await vi.waitFor(() => expect(alive(candidate)).toBe(false), { timeout: 7_000 });
  fs.unlinkSync(fixture.gate);
  expect(await forksDuringReport()).toBe(0);
  expect(pid()).toBe(initial);
  expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/replacement pid=.*did not report ready/));
  expect(readRuntimeCounters()).toMatchObject({ commandsInProcess: before.commandsInProcess, helperRestarts: before.helperRestarts, helperRecycles: before.helperRecycles });
}, 20_000);

it('stops both the serving helper and a candidate that has yet to report ready', async () => {
  await start({ recycleReports: 1 });
  const initial = pid();
  fs.writeFileSync(fixture.gate, '');
  await report(5000);
  await waitFile(fixture.candidate);
  const candidate = Number(fs.readFileSync(fixture.candidate, 'utf8'));
  await stopCommandHelper();
  expect(alive(initial) || alive(candidate)).toBe(false);
  expect(getCommandHelperStatus().state).toBe('stopped');
}, 20_000);

it('preserves the existing failure count and backoff through a successful replacement', async () => {
  await start({ recycleReports: 1, maxConsecutiveFailures: 2, restartDelaysMs: [200], stableUptimeMs: 100_000 });
  const before = readRuntimeCounters();
  const first = pid();
  process.kill(first, 'SIGKILL');
  await changedPid(first);
  const second = pid();
  await report(5000);
  await changedPid(second);
  process.kill(pid(), 'SIGKILL');
  await vi.waitFor(() => expect(getCommandHelperStatus().state).toBe('failed'), { timeout: 10_000 });
  expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('restarts in 200 ms'));
  expect(log).toHaveBeenCalledWith('error', expect.stringContaining('after 2 consecutive failures'));
  expect(readRuntimeCounters().helperRestarts - before.helperRestarts).toBe(1);
}, 20_000);

it.each(['crash', 'shutdown'])('handles %s during drain and cleans up both generations', async (reason) => {
  await start({ recycleReports: 1 });
  const initial = pid();
  const old = heldCommand('old');
  await waitFile(old.started);
  await report(5000);
  await changedPid(initial);
  const current = pid();
  const fresh = heldCommand('fresh');
  await waitFile(fresh.started);
  const restarts = readRuntimeCounters().helperRestarts;
  if (reason === 'crash') {
    process.kill(initial, 'SIGKILL');
    await expect(old.result).rejects.toMatchObject({ code: COMMAND_HELPER_EXITED });
    old.finish();
    fresh.finish();
    await expect(fresh.result).resolves.toHaveProperty('stdout');
    expect(pid()).toBe(current);
  } else {
    await stopCommandHelper();
    await expect(old.result).rejects.toThrow();
    await expect(fresh.result).rejects.toThrow();
    expect(alive(initial) || alive(current)).toBe(false);
  }
  expect(readRuntimeCounters().helperRestarts).toBe(restarts);
}, 30_000);
