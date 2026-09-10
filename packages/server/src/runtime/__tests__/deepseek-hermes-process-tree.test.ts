/**
 * Real-process regression for the DeepSeek Harness ACP launch.
 *
 * `dsh --profile acp` binds stdin EOF to a bounded shutdown that drains its
 * agents and profile tree (see the `@deepseek-ai/dsh-acp-app` contract), so the
 * launch contract is: closing the transport ends the process, and the durable
 * `DSH_HOME` survives because it is state rather than scratch space.
 *
 * Skips itself when no `dsh` executable is resolvable, so a missing optional
 * agent never turns into a red suite. Process enumeration is used only when the
 * host actually allows it.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentType, RuntimeType } from '@agent-tower/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAcpAgentDefinition } from '../acp/agents/registry.js';
import type { RuntimeOpenInput } from '../contracts.js';

function resolveDshExecutable(): string | null {
  const configured = process.env.DSH_PATH?.trim();
  if (configured) return configured;
  try {
    const resolved = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], {
      encoding: 'utf-8',
    }).split('\n')[0]?.trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/** PIDs whose parent is `pid`, or null when this host forbids enumeration. */
function listChildPids(pid: number): number[] | null {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf-8' });
    return output
      .split('\n')
      .map(line => line.trim().split(/\s+/))
      .filter(parts => parts.length === 2 && Number(parts[1]) === pid)
      .map(parts => Number(parts[0]));
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

const dshExecutable = resolveDshExecutable();
const describeWithHarness = dshExecutable ? describe : describe.skip;

describeWithHarness('DeepSeek Harness process lifecycle', () => {
  const originalDataDir = process.env.AGENT_TOWER_DATA_DIR;
  let dataDir: string;
  let workingDir: string;
  let rootPid: number | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-tower-dsh-leak-'));
    workingDir = await mkdtemp(path.join(os.tmpdir(), 'agent-tower-dsh-leak-ws-'));
    process.env.AGENT_TOWER_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (rootPid && isAlive(rootPid)) {
      try { process.kill(-rootPid, 'SIGKILL'); } catch { /* already gone */ }
      try { process.kill(rootPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    rootPid = undefined;
    if (originalDataDir === undefined) delete process.env.AGENT_TOWER_DATA_DIR;
    else process.env.AGENT_TOWER_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
    await rm(workingDir, { recursive: true, force: true });
  });

  it('exits with its whole tree when the transport closes, keeping the durable harness home', async () => {
    const definition = getAcpAgentDefinition(AgentType.DEEPSEEK_HERMES);
    const profile = definition.projectProvider({
      id: 'deepseek-provider',
      name: 'DeepSeek',
      agentType: AgentType.DEEPSEEK_HERMES,
      runtimeType: RuntimeType.ACP,
      env: { DEEPSEEK_API_KEY: 'sk-not-used-for-launch-liveness' },
      config: {},
      isDefault: false,
    } as never, { ...process.env } as Record<string, string>);

    const input: RuntimeOpenInput = {
      towerSessionId: 'lifecycle-regression',
      agentType: AgentType.DEEPSEEK_HERMES,
      runtimeType: RuntimeType.ACP,
      variant: 'default',
      providerId: 'deepseek-provider',
      workingDir,
      env: { toObject: () => ({}), clone: () => undefined } as unknown as RuntimeOpenInput['env'],
    };
    const launch = await definition.resolveLaunch(input, profile);
    // Durable harness state must never be registered as disposable scratch.
    expect(launch.cleanup).toBeUndefined();
    const harnessHome = launch.env.DSH_HOME!;

    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group, matching how Agent Tower launches ACP adapters.
      detached: process.platform !== 'win32',
    });
    rootPid = child.pid;

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    // Wait for the harness to come up: it writes its profile workspace.
    const bootstrapped = await waitFor(
      () => pathExists(path.join(harnessHome, 'profiles', 'acp')),
      30_000,
    );
    expect(bootstrapped).toBe(true);
    expect(isAlive(rootPid!)).toBe(true);

    const childrenBeforeClose = listChildPids(rootPid!);

    // Closing the ACP transport is the documented shutdown trigger.
    child.stdin.end();
    const result = await Promise.race([
      exit,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
    ]);

    expect(result).not.toBeNull();
    expect(isAlive(rootPid!)).toBe(false);
    rootPid = undefined;

    if (childrenBeforeClose) {
      // Enumeration is available on this host: no owned child may outlive the root.
      const survivors = childrenBeforeClose.filter(isAlive);
      expect(survivors).toEqual([]);
    }

    // Durable state survives the transport teardown.
    expect(await pathExists(harnessHome)).toBe(true);
  }, 120_000);
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return await predicate();
}
