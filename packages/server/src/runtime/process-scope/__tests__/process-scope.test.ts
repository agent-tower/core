import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProcessScopeRuntime, parseScopeStatusLine, type ProcessScopeRuntime, type ScopePolicy } from '../process-scope.js';
import { resolveScopeHelper } from '../scope-helper.js';

const helper = process.platform === 'linux' ? resolveScopeHelper() : null;
const runtime = helper ? createProcessScopeRuntime(helper) : null;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const temporaryDirectories: string[] = [];
const fixturePids = new Set<number>();

afterEach(() => {
  for (const pid of fixturePids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
  fixturePids.clear();
  for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-scope-test-'));
  temporaryDirectories.push(dir);
  return dir;
}

function startScope(policy: Partial<ScopePolicy>, command: string, args: string[]) {
  const invocation = runtime!.buildInvocation(
    { id: 'test-scope', graceMs: 200, rootExitSignal: 'SIGTERM', stopOnParentDeath: true, statusFd: 3, ...policy },
    command,
    args,
  );
  const child = spawn(invocation.command, invocation.args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], detached: true });
  fixturePids.add(child.pid!);
  const status: string[] = [];
  const stream = child.stdio[3] as Readable;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) { status.push(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, status, exit };
}

async function readPidFile(file: string): Promise<number> {
  await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true), { timeout: 5000 });
  const pid = Number(fs.readFileSync(file, 'utf8'));
  fixturePids.add(pid);
  return pid;
}

const STUBBORN = "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});setInterval(()=>{},1000)";

describe('process scope runtime', () => {
  it('parses supervisor status lines', () => {
    expect(parseScopeStatusLine('root-exit 3 0')).toEqual({ type: 'root-exit', code: 3, signal: null });
    expect(parseScopeStatusLine('root-exit -1 15')).toEqual({ type: 'root-exit', code: null, signal: 'SIGTERM' });
    expect(parseScopeStatusLine('empty')).toEqual({ type: 'empty' });
    expect(parseScopeStatusLine('something else')).toBeNull();
  });

  it('builds the supervisor invocation from a policy', () => {
    const fake = createProcessScopeRuntime({ path: '/opt/agent-tower-scope', capabilities: { subreaper: true, pidfd: true, childrenFile: true } });
    expect(fake.buildInvocation({ id: 'term-1', graceMs: 1000, rootExitSignal: 'SIGHUP', stopOnParentDeath: true }, '/bin/bash', ['-l'])).toEqual({
      command: '/opt/agent-tower-scope',
      args: ['--id', 'term-1', '--grace', '1000', '--root-exit-signal', 'SIGHUP', '--pdeathsig', '--', '/bin/bash', '-l'],
    });
    expect(fake.buildInvocation({ id: 'cmd', graceMs: 250.4, rootExitSignal: 'none', stopOnParentDeath: false, statusFd: 3 }, 'git', ['status']).args)
      .toEqual(['--id', 'cmd', '--grace', '250', '--root-exit-signal', 'none', '--status-fd', '3', '--', 'git', 'status']);
  });

  it('reports a missing supervisor as already exited', () => {
    const fake: ProcessScopeRuntime = createProcessScopeRuntime({ path: '/opt/agent-tower-scope', capabilities: { subreaper: true, pidfd: true, childrenFile: true } });
    // PID 2^22 is above the default pid_max on Linux and never allocated elsewhere.
    expect(fake.requestStop(4_194_304 + 1, 'SIGTERM')).toBe(false);
    expect(fake.forceStop(4_194_304 + 1)).toBe(false);
  });
});

describe.skipIf(!runtime)('agent-tower-scope supervisor (real processes)', () => {
  it('propagates the command exit code and signal', async () => {
    const exited = startScope({}, '/bin/sh', ['-c', 'exit 3']);
    await expect(exited.exit).resolves.toEqual({ code: 3, signal: null });
    expect(exited.status).toEqual(['root-exit 3 0', 'empty']);

    const signalled = startScope({}, '/bin/sh', ['-c', 'kill -TERM $$']);
    await expect(signalled.exit).resolves.toEqual({ code: null, signal: 'SIGTERM' });
    expect(signalled.status[0]).toBe('root-exit -1 15');
  }, 10_000);

  it('reclaims a detached, environment-less grandchild after its parent exits early', async () => {
    const dir = directory();
    const ready = path.join(dir, 'grandchild.pid');
    const grandchild = `${STUBBORN};require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid))`;
    const root = `setTimeout(()=>{const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{env:{},detached:true,stdio:'ignore'});c.unref();setTimeout(()=>process.exit(0),700)},300)`;
    const scope = startScope({ graceMs: 200 }, process.execPath, ['-e', root]);
    const pid = await readPidFile(ready);
    expect(alive(pid)).toBe(true);
    const result = await scope.exit;
    expect(result).toEqual({ code: 0, signal: null });
    expect(alive(pid)).toBe(false);
    expect(scope.status).toEqual(['root-exit 0 0', 'empty']);
  }, 10_000);

  it('stops a member that moved to its own session and ignores the graceful signal', async () => {
    const dir = directory();
    const ready = path.join(dir, 'member.pid');
    const member = `${STUBBORN};require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid))`;
    const root = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(member)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)`;
    const scope = startScope({ graceMs: 200 }, process.execPath, ['-e', root]);
    const pid = await readPidFile(ready);
    const started = Date.now();
    expect(runtime!.requestStop(scope.child.pid!, 'SIGTERM')).toBe(true);
    await expect(scope.exit).resolves.toEqual({ code: null, signal: 'SIGTERM' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(alive(pid)).toBe(false);
    expect(scope.status.at(-1)).toBe('empty');
  }, 10_000);

  it('escalates immediately when asked to force-stop', async () => {
    const scope = startScope({ graceMs: 10_000 }, process.execPath, ['-e', STUBBORN]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    runtime!.requestStop(scope.child.pid!, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(scope.child.pid!)).toBe(true);
    const started = Date.now();
    runtime!.forceStop(scope.child.pid!);
    await expect(scope.exit).resolves.toEqual({ code: null, signal: 'SIGKILL' });
    expect(Date.now() - started).toBeLessThan(1500);
  }, 10_000);

  it('stops the whole scope when the launching process dies without cleanup', async () => {
    const dir = directory();
    const info = path.join(dir, 'launcher.json');
    const launcher = `
      const {spawn}=require('node:child_process');
      const h=spawn(${JSON.stringify(runtime!.helper.path)},['--grace','200','--root-exit-signal','SIGTERM','--pdeathsig','--','/bin/sleep','300'],{stdio:'ignore'});
      setTimeout(()=>{
        const fs=require('node:fs');
        const children=fs.readFileSync('/proc/'+h.pid+'/task/'+h.pid+'/children','utf8').trim();
        fs.writeFileSync(${JSON.stringify(info)},JSON.stringify({helper:h.pid,sleep:Number(children)}));
      },300);
      setInterval(()=>{},1000);`;
    const launcherProcess: ChildProcess = spawn(process.execPath, ['-e', launcher], { stdio: 'ignore' });
    fixturePids.add(launcherProcess.pid!);
    await vi.waitFor(() => expect(fs.existsSync(info)).toBe(true), { timeout: 5000 });
    const { helper: helperPid, sleep } = JSON.parse(fs.readFileSync(info, 'utf8')) as { helper: number; sleep: number };
    fixturePids.add(helperPid);
    fixturePids.add(sleep);
    expect(alive(helperPid) && alive(sleep)).toBe(true);
    process.kill(launcherProcess.pid!, 'SIGKILL');
    await vi.waitFor(() => expect(alive(sleep) || alive(helperPid)).toBe(false), { timeout: 3000 });
  }, 10_000);
});
