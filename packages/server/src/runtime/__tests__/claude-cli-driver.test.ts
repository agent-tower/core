import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentType, RuntimeType } from '@agent-tower/shared';
import * as executors from '../../executors/index.js';
import { BaseExecutor, type ExecutorSpawnConfig } from '../../executors/base.executor.js';
import { CommandBuilder } from '../../executors/command-builder.js';
import { ExecutionEnv } from '../../executors/execution-env.js';
import { MsgStore } from '../../output/msg-store.js';
import { CliRuntimeDriver } from '../cli-driver.js';
import { RuntimeCoordinator } from '../runtime-coordinator.js';
import type { RuntimeTurnEventEnvelope, RuntimeProcessEvent } from '../contracts.js';

class FixtureExecutor extends BaseExecutor {
  readonly displayName = 'fixture';
  constructor(readonly agentType: AgentType, public mode: string) { super(); }
  getAvailabilityInfo() { return Promise.resolve({ type: 'INSTALLATION_FOUND' as const }); }
  protected buildCommandBuilder() { return CommandBuilder.new(process.execPath); }
  async spawn(config: ExecutorSpawnConfig) {
    const fixture = fileURLToPath(new URL(this.agentType === AgentType.CODEX ? './fixtures/codex-app-server.cjs' : './fixtures/claude-control.cjs', import.meta.url));
    const child = await this.spawnWithDuplex(config, { program: process.execPath, args: [fixture, this.mode] });
    child.initialInput = this.agentType === AgentType.CODEX ? JSON.stringify({ cwd: config.workingDir, input: [{ type: 'text', text: config.prompt, text_elements: [] }] })
      : JSON.stringify({ type: 'user', message: { content: config.prompt } }) + '\n'; return child;
  }
  async spawnFollowUp(config: ExecutorSpawnConfig) { return this.spawn(config); }
}
async function setupFixture(agentType: AgentType, mode = 'normal', rejectCleanup?: { value: boolean }, startGate?: Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tower-cli-control-test-'));
  const executor = new FixtureExecutor(agentType, mode);
  vi.spyOn(executors, 'getExecutor').mockReturnValue(executor);
  const events: RuntimeTurnEventEnvelope[] = []; const processes: RuntimeProcessEvent[] = [];
  const coordinator = new RuntimeCoordinator({ get: () => new CliRuntimeDriver() }, {
    onTurnEvent: e => events.push(e), onRuntimeState: () => {}, onProcessEvent: async e => { processes.push(e); if (e.type === 'started') await startGate; if (e.type === 'tree_cleanup_completed' && rejectCleanup?.value) throw new Error('persistence failed'); },
  });
  const input = { towerSessionId: 'tower', agentType, runtimeType: RuntimeType.CLI, variant: 'DEFAULT', workingDir: dir, env: ExecutionEnv.default(dir), executionPermission: 'ASK' as const, msgStore: new MsgStore(), prompt: 'task' };
  return { dir, events, processes, coordinator, input, executor, cleanup: async () => { await coordinator.destroyAll(); await rm(dir, { recursive: true, force: true }); } };
}
async function waitUntil(test: () => boolean) { const deadline = Date.now() + 5000; while (!test() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10)); expect(test()).toBe(true); }
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
afterEach(() => vi.restoreAllMocks());
describe.each([AgentType.CLAUDE_CODE, AgentType.CODEX])('%s CLI through the owned wrapper and coordinator', agentType => {
  const setup = (mode?: string, rejectCleanup?: { value: boolean }, startGate?: Promise<void>) => setupFixture(agentType, mode, rejectCleanup, startGate);
  const confirmMethod = agentType === AgentType.CODEX ? 'thread/start' : 'set_permission_mode';
  const receivedHandshake = agentType === AgentType.CODEX ? 'initialize\ninitialized\nthread/start\n' : 'initialize\nset_permission_mode\n';
  const taskMethod = agentType === AgentType.CODEX ? 'turn/start' : 'user';
  it('preserves delayed final output after logical completion and confirms owner cleanup', async () => {
    const h = await setup('delayed-tail');
    try {
      const handle = await h.coordinator.startTurn(h.input); await handle.completion;
      await waitUntil(() => h.processes.some(e => e.type === 'tree_cleanup_completed'));
      expect(JSON.stringify(h.input.msgStore.getSnapshot())).toContain('tail after logical completion');
      expect(h.processes.filter(e => e.type === 'tree_cleanup_completed')).toHaveLength(1);
    } finally { await h.cleanup(); }
  }, 15_000);
  it.each(['allow_once', 'reject_once'])('continues the reader, recovers pending state and delivers %s once', async option => {
    const h = await setup();
    try {
      const handle = await h.coordinator.startTurn(h.input);
      await waitUntil(() => h.events.some(e => e.event.type === 'permission_invalidated'));
      const state = h.coordinator.getState('tower');
      expect(state).toMatchObject({ turnState: 'AWAITING_PERMISSION', executionPermission: 'ASK', capabilities: { permissions: true, terminalInput: false } });
      expect(state.pendingPermissions).toHaveLength(1);
      expect(JSON.stringify(h.input.msgStore.getSnapshot())).toContain('reader stays active');
      expect(JSON.stringify(h.input.msgStore.getSnapshot())).not.toContain('control_request');
      expect(() => h.coordinator.writeInput('tower', 'arbitrary protocol')).toThrow(/cannot be written/);
      const id = state.pendingPermissions[0]!.requestId;
      await h.coordinator.resolvePermission('tower', id, option);
      await handle.completion;
      await expect(h.coordinator.resolvePermission('tower', id, option)).rejects.toMatchObject({ code: 'permission_not_found' });
      if (option === 'allow_once') await access(path.join(h.dir, 'action.txt')); else await expect(access(path.join(h.dir, 'action.txt'))).rejects.toThrow();
      await waitUntil(() => h.processes.some(e => e.type === 'tree_cleanup_completed'));
    } finally { await h.cleanup(); }
  }, 15_000);
  it('stopping invalidates the old button and cleans the whole launch', async () => {
    const h = await setup();
    try {
      const handle = await h.coordinator.startTurn(h.input); void handle.completion.catch(() => {});
      await waitUntil(() => h.coordinator.getState('tower').pendingPermissions.length === 1);
      const id = h.coordinator.getState('tower').pendingPermissions[0]!.requestId;
      await h.coordinator.cancelTurn('tower');
      await expect(h.coordinator.resolvePermission('tower', id, 'allow_once')).rejects.toMatchObject({ code: 'permission_not_found' });
      await expect(access(path.join(h.dir, 'action.txt'))).rejects.toThrow();
      await waitUntil(() => h.processes.some(e => e.type === 'tree_cleanup_completed'));
    } finally { await h.cleanup(); }
  }, 15_000);
  it.each([
    { phase: 'pending', cancel: 'abandonTurn' },
    { phase: 'running', cancel: 'abandonTurn' },
    { phase: 'pending', cancel: 'cancelTurn' },
    { phase: 'running', cancel: 'cancelTurn' },
    { phase: 'pending', cancel: 'cancelAndDisposeSession' },
    { phase: 'running', cancel: 'cancelAndDisposeSession' },
  ] as const)('starts a replacement after $cancel of a $phase turn only once its real tree is clean', async ({ phase, cancel }) => {
    const h = await setup(`cancel-${phase}`);
    try {
      const old = await h.coordinator.startTurn({ ...h.input, launchClaimNumber: 1 });
      void old.completion.catch(() => undefined);
      await waitUntil(() => h.coordinator.getState('tower').pendingPermissions.length === 1);
      const request = h.coordinator.getState('tower').pendingPermissions[0]!;
      const firstLaunch = h.processes.find(e => e.type === 'started')!;
      const oldPids: number[] = JSON.parse(await readFile(path.join(h.dir, 'old-processes.json'), 'utf8'));
      expect(oldPids.every(isAlive)).toBe(true);
      expect(isAlive(firstLaunch.pid!)).toBe(true);
      if (phase === 'running') {
        await h.coordinator.resolvePermission('tower', request.requestId, 'allow_once');
        await waitUntil(() => JSON.stringify(h.input.msgStore.getSnapshot()).includes('action is running'));
        expect(h.coordinator.getState('tower').turnState).toBe('RUNNING');
      } else {
        expect(h.coordinator.getState('tower').turnState).toBe('AWAITING_PERMISSION');
      }

      h.executor.mode = 'normal';
      const reusable = await h.coordinator[cancel]('tower');
      if (cancel === 'abandonTurn') expect(reusable).toBe(true);
      expect(h.coordinator.getState('tower').pendingPermissions).toEqual([]);
      // This is the replacement contract used by SessionManager.sendMessage:
      // keep the same DriverSession and immediately start the next CLI turn.
      const next = await h.coordinator.startTurn({ ...h.input, launchClaimNumber: 2, resumeExternalSessionId: 'native-session' });
      await waitUntil(() => h.coordinator.getState('tower').pendingPermissions.length === 1);
      const nextRequest = h.coordinator.getState('tower').pendingPermissions[0]!;
      expect(nextRequest.requestId).not.toBe(request.requestId);
      expect(nextRequest.turnId).toBe(next.turnId);
      await expect(old.completion).rejects.toMatchObject({ code: 'turn_cancelled' });
      // Even while the replacement offers the same native tool/request ID,
      // the old generation's delayed approval cannot reach its stdin.
      await expect(h.coordinator.resolvePermission('tower', request.requestId, 'allow_once')).rejects.toMatchObject({ code: 'permission_not_found' });
      expect(h.coordinator.getState('tower').pendingPermissions).toEqual([nextRequest]);
      await h.coordinator.resolvePermission('tower', nextRequest.requestId, 'reject_once');
      await next.completion;
      const starts = h.processes.filter(e => e.type === 'started');
      expect(starts).toHaveLength(2);
      expect(starts[1]!.runtimeInstanceId).not.toBe(firstLaunch.runtimeInstanceId);
      const cleaned = h.processes.findIndex(e => e.type === 'tree_cleanup_completed' && e.runtimeInstanceId === firstLaunch.runtimeInstanceId);
      expect(cleaned).toBeGreaterThan(-1);
      expect(cleaned).toBeLessThan(h.processes.indexOf(starts[1]!));
      expect(isAlive(firstLaunch.pid!)).toBe(false);
      expect(oldPids.some(isAlive)).toBe(false);
      await expect(access(path.join(h.dir, 'action.txt'))).rejects.toThrow();
      await waitUntil(() => h.processes.filter(e => e.type === 'tree_cleanup_completed').length === 2);
      // All replacement/cleanup assertions precede the final disposal fallback.
    } finally { await h.cleanup(); }
  }, 15_000);
  it.each(['modefail', 'eof'])('fails and cleans up when native %s occurs', async mode => {
    const h = await setup(mode);
    try {
      if (mode === 'modefail') {
        await expect(h.coordinator.startTurn({ ...h.input, resumeExternalSessionId: 'historical-full' })).rejects.toMatchObject({ code: 'control_request_failed' });
        expect(h.processes.filter(e => e.type === 'started')).toHaveLength(1);
        expect(await readFile(path.join(h.dir, 'received.txt'), 'utf8')).toBe(receivedHandshake);
      }
      else {
        const handle = await h.coordinator.startTurn(h.input); await expect(handle.completion).rejects.toMatchObject({ code: 'control_disconnected' });
      }
    } finally { await h.cleanup(); }
    expect(h.processes.some(e => e.type === 'tree_cleanup_completed')).toBe(true);
  }, 15_000);
  it('sends no initialization or task before the durable started barrier succeeds', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const h = await setup('result', undefined, gate);
    const start = h.coordinator.startTurn(h.input); void start.catch(() => {});
    try {
      await waitUntil(() => h.processes.some(e => e.type === 'started'));
      await expect(access(path.join(h.dir, 'received.txt'))).rejects.toThrow();
      release(); const handle = await start; await handle.completion;
      expect(await readFile(path.join(h.dir, 'received.txt'), 'utf8')).toBe(receivedHandshake + taskMethod + '\n');
    } finally { release(); await h.cleanup(); }
  }, 15_000);
  it('stops and cleans the owned process during a pending permission-mode handshake', async () => {
    const h = await setup('modehang'); const start = h.coordinator.startTurn(h.input); void start.catch(() => {});
    try {
      await waitUntil(() => h.processes.some(e => e.type === 'started'));
      const deadline = Date.now() + 5000;
      let received = '';
      while (!received.includes(confirmMethod) && Date.now() < deadline) {
        received = await readFile(path.join(h.dir, 'received.txt'), 'utf8').catch(() => '');
        if (!received.includes(confirmMethod)) await new Promise(r => setTimeout(r, 10));
      }
      expect(received).toContain(confirmMethod);
      const stop = h.coordinator.cancelAndDisposeSession('tower');
      await expect(start).rejects.toThrow(); await stop;
      expect(await readFile(path.join(h.dir, 'received.txt'), 'utf8')).not.toContain(taskMethod);
      expect(h.processes.some(e => e.type === 'tree_cleanup_completed')).toBe(true);
    } finally { await h.cleanup(); }
  }, 15_000);
  it('retains an unacknowledged cleanup owner and blocks a replacement until persistence recovers', async () => {
    const rejectCleanup = { value: true }; const h = await setup('result', rejectCleanup);
    try {
      const handle = await h.coordinator.startTurn(h.input); await handle.completion;
      await waitUntil(() => h.processes.some(e => e.type === 'tree_cleanup_completed'));
      await expect(h.coordinator.startTurn(h.input)).rejects.toMatchObject({ code: 'runtime_cleanup_pending' });
      expect(h.processes.filter(e => e.type === 'started')).toHaveLength(1);
    } finally { rejectCleanup.value = false; await h.cleanup(); }
  }, 15_000);
  it.each(['result', 'tail'])('treats %s as logical completion, sends EOF, and starts a fresh resume generation only after cleanup', async mode => {
    const h = await setup(mode);
    try {
      for (let claim = 1; claim <= 2; claim++) {
        const handle = await h.coordinator.startTurn({ ...h.input, launchClaimNumber: claim, resumeExternalSessionId: claim === 2 ? 'native-session' : undefined });
        await handle.completion;
      }
      await waitUntil(() => h.processes.filter(e => e.type === 'tree_cleanup_completed').length === 2);
      expect(new Set(h.processes.filter(e => e.type === 'started').map(e => e.runtimeInstanceId)).size).toBe(2);
    } finally { await h.cleanup(); }
  }, 15_000);
});

describe('Codex CLI auto-review through the owned driver', () => {
  it('stops and cleans a native auto_review rejection without retrying another permission mode', async () => {
    const h = await setupFixture(AgentType.CODEX, 'modefail');
    try {
      await expect(h.coordinator.startTurn({ ...h.input, executionPermission: 'AUTO_SANDBOX' }))
        .rejects.toMatchObject({ code: 'permission_mode_unconfirmed', message: expect.stringContaining('auto_review') });
      expect(await readFile(path.join(h.dir, 'received.txt'), 'utf8')).toBe('initialize\ninitialized\nthread/start\n');
      await waitUntil(() => h.processes.some(event => event.type === 'tree_cleanup_completed'));
      expect(h.processes.filter(event => event.type === 'started')).toHaveLength(1);
    } finally { await h.cleanup(); }
  }, 15_000);
  it('rejects a permission snapshot mismatch before any Codex child starts', async () => {
    const h = await setupFixture(AgentType.CODEX);
    try {
      const providerSnapshot = { id: 'codex', name: 'Codex', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
        executionPermission: 'ASK' as const, env: {}, config: {}, isDefault: false };
      await expect(h.coordinator.startTurn({ ...h.input, executionPermission: 'AUTO_SANDBOX', providerSnapshot }))
        .rejects.toMatchObject({ code: 'provider_config_invalid' });
      expect(h.processes.some(event => event.type === 'started')).toBe(false);
    } finally { await h.cleanup(); }
  });
  it('keeps native remaining requests pending and cleans the old process before an ASK replacement', async () => {
    const h = await setupFixture(AgentType.CODEX);
    try {
      const autoInput = { ...h.input, executionPermission: 'AUTO_SANDBOX' as const, launchClaimNumber: 1 };
      const old = await h.coordinator.startTurn(autoInput); void old.completion.catch(() => {});
      await waitUntil(() => h.coordinator.getState('tower').pendingPermissions.length === 1);
      const pending = h.coordinator.getState('tower').pendingPermissions[0]!;
      const first = h.processes.find(event => event.type === 'started')!;
      expect(h.coordinator.getState('tower').executionPermission).toBe('AUTO_SANDBOX');
      expect(await readFile(path.join(h.dir, 'received.txt'), 'utf8')).not.toContain('decision');
      await h.coordinator.cancelTurn('tower');
      const next = await h.coordinator.startTurn({ ...h.input, launchClaimNumber: 2, resumeExternalSessionId: 'native-thread' });
      await waitUntil(() => h.coordinator.getState('tower').pendingPermissions.length === 1);
      expect(h.coordinator.getState('tower').executionPermission).toBe('ASK');
      await expect(h.coordinator.resolvePermission('tower', pending.requestId, 'allow_once')).rejects.toMatchObject({ code: 'permission_not_found' });
      const clean = h.processes.findIndex(event => event.type === 'tree_cleanup_completed' && event.runtimeInstanceId === first.runtimeInstanceId);
      const second = h.processes.findIndex(event => event.type === 'started' && event.runtimeInstanceId !== first.runtimeInstanceId);
      expect(clean).toBeGreaterThan(-1); expect(second).toBeGreaterThan(clean);
      await h.coordinator.resolvePermission('tower', h.coordinator.getState('tower').pendingPermissions[0]!.requestId, 'reject_once');
      await next.completion;
      await waitUntil(() => h.processes.filter(event => event.type === 'tree_cleanup_completed').length === 2);
    } finally { await h.cleanup(); }
  }, 15_000);
});
