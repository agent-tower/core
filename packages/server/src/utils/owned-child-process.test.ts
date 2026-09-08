import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnedChildProcess, runOwnedCommand, spawnOwnedProcess } from './owned-child-process.js';
import { AgentCliInstallTaskManager } from '../services/agent-cli/task-manager.js';
import type { AgentCliStoredPreview } from '../services/agent-cli/downloader.js';
import { execGit } from '../git/git-cli.js';

const temporaryDirectories: string[] = [];
const fixturePids = new Set<number>();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

afterEach(async () => {
  for (const pid of fixturePids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already cleaned by the owner */ }
  }
  fixturePids.clear();
  for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-owned-child-test-'));
  temporaryDirectories.push(dir);
  return dir;
}

function installerFixture() {
  const dir = directory();
  const previewDir = path.join(dir, 'preview');
  fs.mkdirSync(previewDir);
  const ready = path.join(dir, 'descendant.pid');
  const descendant = path.join(dir, 'descendant.cjs');
  fs.writeFileSync(descendant, `process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`);
  const installer = path.join(previewDir, 'install.cjs');
  fs.writeFileSync(installer, `require('node:child_process').spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000);`);
  const preview = {
    id: 'fixture-preview', toolId: 'codex', platform: process.platform, status: 'ready',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), tempFilePath: installer,
    interpreter: { command: process.execPath, args: [] }, fixedArgs: [],
    verifyCommand: { command: process.execPath, args: ['--version'], timeoutMs: 1000 },
  } as unknown as AgentCliStoredPreview;
  const manager = new AgentCliInstallTaskManager((command, args, options) => {
    const child = spawnOwnedProcess(command, args, { env: options.env, graceMs: 100 });
    if (child.pid) fixturePids.add(child.pid);
    return child;
  }, 100, async () => {});
  return { ready, preview, manager };
}

describe('owned external commands', () => {
  it.skipIf(process.platform === 'win32')('reclaims a late markerless descendant after its root exits naturally', async () => {
    const dir = directory();
    const ready = path.join(dir, 'markerless.pid');
    const descendantSource = `process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
    const rootSource = `setTimeout(()=>{const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{env:{},detached:true,stdio:'ignore'});child.unref();setTimeout(()=>process.exit(0),700)},300)`;
    let descendantPid = 0;
    const command = runOwnedCommand(process.execPath, ['-e', rootSource], { cwd: dir, timeout: 5000 });
    // Observe rejection immediately while retaining the original result below.
    void command.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), { timeout: 5000 });
      descendantPid = Number(fs.readFileSync(ready, 'utf8'));
      fixturePids.add(descendantPid);
      await command;
      expect(alive(descendantPid)).toBe(false);
    } finally {
      if (!descendantPid && fs.existsSync(ready)) descendantPid = Number(fs.readFileSync(ready, 'utf8'));
      if (descendantPid && alive(descendantPid)) {
        try { process.kill(descendantPid, 'SIGKILL'); } catch { /* own fixture already exited */ }
      }
      await command.catch(() => undefined);
    }
  }, 10_000);

  it.skipIf(process.platform === 'win32')('cleans a native child even when macOS ps hides its environment', async () => {
    const child = spawnOwnedProcess('/bin/sleep', ['30'], { graceMs: 100 });
    fixturePids.add(child.pid!);
    await child.owner.stop();
    expect(alive(child.pid!)).toBe(false);
  }, 10_000);

  it.skipIf(process.platform === 'win32')('cancels a real installer whose descendant survives the parent exit', async () => {
    const { manager, preview, ready } = installerFixture();
    const { task } = manager.createTask(preview);
    await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), { timeout: 5000 });
    const pid = Number(fs.readFileSync(ready, 'utf8'));
    fixturePids.add(pid);
    manager.cancel(task.id);
    await vi.waitFor(() => expect(manager.getTask(task.id).status).toBe('cancelled'), { timeout: 5000 });
    expect(alive(pid)).toBe(false);
    await manager.shutdown();
  }, 10_000);

  it.skipIf(process.platform === 'win32')('shutdown stops installers and rejects later launches', async () => {
    const { manager, preview, ready } = installerFixture();
    const { task } = manager.createTask(preview);
    await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), { timeout: 5000 });
    const pid = Number(fs.readFileSync(ready, 'utf8'));
    fixturePids.add(pid);
    await manager.shutdown();
    expect(alive(pid)).toBe(false);
    expect(manager.getTask(task.id).status).toBe('cancelled');
    expect(() => manager.createTask(preview)).toThrow('shutting down');
    await manager.shutdown();
  }, 10_000);

  it.skipIf(process.platform === 'win32')('reclaims a real Git hook before returning a timeout error', async () => {
    const dir = directory();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'audit@example.invalid'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Audit'], { cwd: dir });
    const ready = path.join(dir, 'hook.pid');
    const hook = path.join(dir, '.git/hooks/pre-commit');
    fs.writeFileSync(hook, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);\n`, { mode: 0o700 });
    const pending = execGit(dir, ['commit', '--allow-empty', '-m', 'test'], { timeout: 500 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), { timeout: 5000 });
    const pid = Number(fs.readFileSync(ready, 'utf8'));
    fixturePids.add(pid);
    await rejected;
    expect(alive(pid)).toBe(false);
  }, 10_000);

  it('retains a verified Windows descendant after the launcher exits', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 501, exitCode: null, signalCode: null, kill: vi.fn() });
    const root = { pid: 501, parentPid: 1, birthMarker: 'root-launch' };
    const descendant = { pid: 502, parentPid: 501, birthMarker: 'child-launch' };
    const living = new Set([501, 502]);
    const terminateTree = vi.fn(async (pid: number) => { living.delete(pid); });
    const owner = new OwnedChildProcess(child as unknown as ChildProcess, 'token', {
      platform: 'win32', graceMs: 1,
      windows: {
        captureProcess: async () => root,
        captureDescendants: async (pid) => pid === 501 ? [descendant] : [],
        isProcessAlive: async (identity) => living.has(identity.pid),
        terminateTree,
      },
    });
    await owner.ready();
    living.delete(501);
    child.emit('exit', 0, null);
    await owner.stop();
    expect(terminateTree).toHaveBeenCalledWith(502);
    expect(terminateTree).not.toHaveBeenCalledWith(501);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('never launches a Windows command cancelled during wrapper identity capture', async () => {
    const dir = directory();
    const marker = path.join(dir, 'unexpected-launch');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const child = spawnOwnedProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], {
      platform: 'win32',
      windows: {
        captureProcess: async (pid) => { await gate; return { pid, parentPid: process.pid, birthMarker: 'fixture-wrapper' }; },
        captureDescendants: async () => [],
        isProcessAlive: async (identity) => alive(identity.pid),
        terminateTree: async (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* own fixture already exited */ } },
      },
    });
    fixturePids.add(child.pid!);
    const stopped = child.owner.stop();
    release();
    await stopped;
    expect(fs.existsSync(marker)).toBe(false);
    expect(alive(child.pid!)).toBe(false);
  }, 10_000);

  it('preserves command output and nonzero exit errors', async () => {
    await expect(runOwnedCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeout: 5000 })).resolves.toEqual({ stdout: 'ok', stderr: '' });
    await expect(runOwnedCommand(process.execPath, ['-e', 'process.stderr.write("failed");process.exit(2)'], { timeout: 5000 })).rejects.toMatchObject({ code: 2, stderr: 'failed' });
  }, 10_000);

  it.skipIf(process.platform === 'win32')('aborts a verifier command only after its process exits', async () => {
    const dir = directory();
    const ready = path.join(dir, 'verifier.pid');
    const controller = new AbortController();
    const pending = runOwnedCommand(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`], {
      timeout: 10_000, signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR' });
    await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), { timeout: 5000 });
    const pid = Number(fs.readFileSync(ready, 'utf8'));
    fixturePids.add(pid);
    controller.abort();
    await rejected;
    expect(alive(pid)).toBe(false);
  }, 10_000);
});
