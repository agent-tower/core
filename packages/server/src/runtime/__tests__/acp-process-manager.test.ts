import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AcpProcessManager,
  cleanupPersistedAcpProcessTree,
  type AcpProcessExit,
  type WindowsProcessTreeAdapter,
} from '../acp/process-manager.js';
import {
  codexAcpMaxStdoutFrameBytes,
  normalizeCodexAcpStdoutFrame,
} from '../acp/agents/codex-frame-normalizer.js';
import { acpLaunchCleanupRegistry } from '../acp/launch-cleanup-registry.js';
import { RuntimeCoordinator } from '../runtime-coordinator.js';
import { StaticRuntimeRegistry } from '../runtime-registry.js';
import {
  createUnixProcessIdentityAdapter,
  type UnixProcessIdentity,
} from '../../utils/unix-process-identity.js';

afterEach(() => {
  acpLaunchCleanupRegistry.shutdown();
});

function managerFor(
  source: string,
  options: Partial<ConstructorParameters<typeof AcpProcessManager>[0]> = {},
  managerOptions: ConstructorParameters<typeof AcpProcessManager>[1] = {},
) {
  return new AcpProcessManager({
    command: process.execPath,
    args: ['-e', source],
    cwd: process.cwd(),
    env: { ...process.env },
    ...options,
  }, managerOptions);
}

function waitForExit(manager: AcpProcessManager): Promise<AcpProcessExit> {
  return new Promise((resolve) => manager.onExit(resolve));
}

describe('AcpProcessManager', () => {
  it('forwards valid NDJSON and bounds/redacts stderr diagnostics', async () => {
    const manager = managerFor([
      "process.stderr.write('authorization: token-secretvalue123\\n')",
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{ok:true}})+'\\n')",
    ].join(';'));
    const streams = await manager.start();
    const exit = waitForExit(manager);
    const reader = streams.output.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }

    expect(JSON.parse(output.trim())).toMatchObject({ id: 1, result: { ok: true } });
    await expect(exit).resolves.toMatchObject({
      exitCode: 0,
      stderrExcerpt: expect.stringContaining('[REDACTED]'),
    });
  });

  it('rejects malformed ACP stdout frames', async () => {
    const manager = managerFor("process.stdout.write('not-json\\n')");
    const streams = await manager.start();
    const reader = streams.output.getReader();

    await expect(reader.read()).rejects.toMatchObject({ code: 'protocol_violation' });
    await waitForExit(manager);
  });

  it('keeps the default one MiB limit for agents without a frame normalizer', async () => {
    const manager = managerFor([
      "const output='x'.repeat(600*1024)",
      "const update={rawOutput:{formatted_output:output},_meta:{terminal_output_delta:{data:output}}}",
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{update}})+'\\n')",
    ].join(';'));
    const streams = await manager.start();

    await expect(streams.output.getReader().read()).rejects.toMatchObject({ code: 'protocol_violation' });
    await manager.stop();
  }, 15_000);

  it('normalizes duplicated Codex command output before enforcing the SDK frame limit', async () => {
    const manager = managerFor([
      "const output='x'.repeat(600*1024)",
      "const update={sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',rawOutput:{formatted_output:output,exit_code:0},_meta:{terminal_output_delta:{data:output,terminal_id:'tool-1'}}}",
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session-1',update}})+'\\n')",
    ].join(';'), {
      maxStdoutFrameBytes: codexAcpMaxStdoutFrameBytes,
      transformStdoutFrame: normalizeCodexAcpStdoutFrame,
    });
    const streams = await manager.start();
    const exit = waitForExit(manager);
    const reader = streams.output.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }

    const frame = JSON.parse(output.trim());
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(1024 * 1024);
    expect(frame.params.update.rawOutput.formatted_output).toContain('[TRUNCATED]');
    expect(frame.params.update.rawOutput.formatted_output.length).toBeLessThanOrEqual(32 * 1024);
    expect(frame.params.update._meta).not.toHaveProperty('terminal_output_delta');
    await expect(exit).resolves.toMatchObject({ exitCode: 0 });
  });

  it('normalizes Codex command output that exceeds the previous raw frame limit', async () => {
    const manager = managerFor([
      "const output='x'.repeat(9*1024*1024)",
      "const update={sessionUpdate:'tool_call_update',toolCallId:'tool-large',status:'completed',rawOutput:{formatted_output:output,exit_code:0},_meta:{terminal_output_delta:{data:output,terminal_id:'tool-large'}}}",
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session-1',update}})+'\\n')",
    ].join(';'), {
      maxStdoutFrameBytes: codexAcpMaxStdoutFrameBytes,
      transformStdoutFrame: normalizeCodexAcpStdoutFrame,
    });
    const streams = await manager.start();
    const reader = streams.output.getReader();
    const result = await reader.read();
    const output = new TextDecoder().decode(result.value);
    const frame = JSON.parse(output.trim());

    expect(result.done).toBe(false);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(1024 * 1024);
    expect(frame.params.update.rawOutput.formatted_output).toContain('[TRUNCATED]');
    expect(frame.params.update._meta).not.toHaveProperty('terminal_output_delta');
    await manager.stop();
  });

  it('bounds oversized structured Codex tool payloads', async () => {
    const manager = managerFor([
      "const image='data:image/png;base64,'+'x'.repeat(2*1024*1024)",
      "const update={sessionUpdate:'tool_call',toolCallId:'tool-image',status:'completed',rawInput:{image},rawOutput:{output:[{type:'input_image',image_url:image}]},content:[{type:'content',content:{type:'image',data:image,mimeType:'image/png'}}]}",
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session-1',update}})+'\\n')",
    ].join(';'), {
      maxStdoutFrameBytes: codexAcpMaxStdoutFrameBytes,
      transformStdoutFrame: normalizeCodexAcpStdoutFrame,
    });
    const streams = await manager.start();
    const result = await streams.output.getReader().read();
    const output = new TextDecoder().decode(result.value);
    const frame = JSON.parse(output.trim());

    expect(result.done).toBe(false);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(1024 * 1024);
    expect(frame.params.update.rawOutput).toMatchObject({
      _truncated: true,
      preview: expect.stringContaining('[TRUNCATED]'),
    });
    expect(frame.params.update.rawOutput.preview.length).toBeLessThanOrEqual(32 * 1024);
    expect(frame.params.update.rawInput).toMatchObject({ _truncated: true });
    expect(frame.params.update.content[0].content.text).toContain('[TRUNCATED]');
    await manager.stop();
  });

  it('keeps a bounded terminal delta when dropping oversized Codex metadata', async () => {
    const manager = managerFor([
      "const output='x'.repeat(2*1024*1024)",
      "const update={sessionUpdate:'tool_call_update',toolCallId:'tool-stream',_meta:{terminal_output_delta:{data:output,terminal_id:'tool-stream'},diagnostic:output}}",
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session-1',update}})+'\\n')",
    ].join(';'), {
      maxStdoutFrameBytes: codexAcpMaxStdoutFrameBytes,
      transformStdoutFrame: normalizeCodexAcpStdoutFrame,
    });
    const streams = await manager.start();
    const result = await streams.output.getReader().read();
    const output = new TextDecoder().decode(result.value);
    const frame = JSON.parse(output.trim());

    expect(result.done).toBe(false);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(1024 * 1024);
    expect(frame.params.update._meta).toMatchObject({
      _truncated: true,
      terminal_output_delta: {
        terminal_id: 'tool-stream',
        data: expect.stringContaining('[TRUNCATED]'),
      },
    });
    expect(frame.params.update._meta).not.toHaveProperty('diagnostic');
    await manager.stop();
  }, 15_000);

  it('terminates the detached adapter process on stop', async () => {
    const manager = managerFor("process.on('SIGTERM',()=>process.exit(0));process.stdout.write('{}\\n');setInterval(()=>{},1000)");
    const streams = await manager.start();
    await streams.output.getReader().read();

    await expect(manager.stop()).resolves.toMatchObject({ exitCode: 0 });
  });

  it('keeps discovering marker-owned groups after the root exits', async () => {
    const captureOwnedGroups = vi.fn(async (_token: string, processGroupId?: number) => ([{
      pgid: processGroupId === undefined ? 7802 : processGroupId,
      members: [{
        pid: 7802,
        pgid: processGroupId === undefined ? 7802 : processGroupId,
        birthIdentity: 'linux:escaped-owner',
        ownershipToken: _token,
      }],
    }]));
    let rootPid = 0;
    const unixProcessAdapter = {
      captureProcess: vi.fn(async (pid: number, ownershipToken: string) => {
        rootPid = pid;
        return { pid, pgid: 7801, birthIdentity: 'linux:root-owner', ownershipToken };
      }),
      captureDescendantGroups: vi.fn(async () => []),
      captureOwnedGroups,
      isProcessAlive: vi.fn(async (identity: UnixProcessIdentity) => identity.pid === rootPid && !identity.birthIdentity.includes('escaped')),
      isProcessGroupAlive: vi.fn(async () => false),
      signalProcess: vi.fn(async () => false),
      signalProcessGroup: vi.fn(async () => true),
    };
    const manager = managerFor('setTimeout(() => process.exit(0), 20)', {}, {
      platform: 'linux',
      unixProcessAdapter,
    });

    await manager.start();
    await waitForExit(manager);
    await expect(manager.stop()).resolves.toMatchObject({ exitCode: 0 });

    expect(captureOwnedGroups).toHaveBeenCalled();
    expect(captureOwnedGroups.mock.calls.every((call) => call.length === 1)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('kills and verifies the root and descendant identities', async () => {
    const manager = managerFor([
      "const {spawn}=require('node:child_process')",
      "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
      "process.stdout.write(JSON.stringify({descendantPid:child.pid})+'\\n')",
      "setTimeout(()=>process.exit(0),50)",
    ].join(';'));
    const identityAdapter = createUnixProcessIdentityAdapter(process.platform);
    let rootIdentity: UnixProcessIdentity | undefined;
    let descendantIdentity: UnixProcessIdentity | undefined;
    let descendantPid: number | undefined;

    try {
      const streams = await manager.start();
      const rootPid = streams.pid;
      rootIdentity = {
        pid: rootPid,
        pgid: Number(streams.processGroupId),
        birthIdentity: streams.birthMarker,
        ownershipToken: streams.ownershipToken,
      };
      const result = await streams.output.getReader().read();
      descendantPid = Number(JSON.parse(new TextDecoder().decode(result.value)).descendantPid);
      expect(descendantPid).toBeGreaterThan(0);
      expect(descendantPid).not.toBe(rootPid);
      await waitForExit(manager);
      descendantIdentity = await captureOwnedIdentity(
        identityAdapter,
        streams.ownershipToken,
        descendantPid,
      );
      expect(descendantIdentity).toBeDefined();

      await expect(manager.stop()).resolves.toMatchObject({ exitCode: 0 });
      await expect(identityAdapter.isProcessAlive(rootIdentity)).resolves.toBe(false);
      await expect(identityAdapter.isProcessAlive(descendantIdentity!)).resolves.toBe(false);
    } finally {
      await manager.stop().catch(() => undefined);
      if (!descendantIdentity && descendantPid) {
        descendantIdentity = await captureOwnedIdentity(
          identityAdapter,
          rootIdentity?.ownershipToken ?? '',
          descendantPid,
        );
      }
      for (const identity of [descendantIdentity, rootIdentity]) {
        if (identity && await identityAdapter.isProcessAlive(identity)) {
          await identityAdapter.signalProcess(identity, 'SIGKILL');
          await waitForIdentityExit(identityAdapter, identity);
        }
      }
      await acpLaunchCleanupRegistry.drain();
    }
  }, 15_000);

  it('retains a spawned manager owner across failed coordinator destroy until the child exits', async () => {
    const windowsProcessAdapter: WindowsProcessTreeAdapter = {
      captureProcess: async () => null,
      captureDescendants: async () => [],
      isProcessAlive: async () => true,
      terminateTree: vi.fn(async () => undefined),
    };
    const manager = managerFor('setTimeout(() => process.exit(0), 600)', {}, {
      platform: 'win32',
      windowsProcessAdapter,
    });
    const exit = waitForExit(manager);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const coordinator = new RuntimeCoordinator(new StaticRuntimeRegistry([]), {
      onTurnEvent: () => undefined,
      onRuntimeState: () => undefined,
      onProcessEvent: async () => undefined,
    });

    try {
      await expect(manager.start()).rejects.toBeDefined();
      const ownerId = manager.getPostSpawnCleanupOwnerId();
      expect(ownerId).toBeTruthy();

      await expect(coordinator.destroyAll()).rejects.toMatchObject({ code: 'runtime_cleanup_pending' });
      const unresolved = acpLaunchCleanupRegistry.getState(ownerId!);
      expect(unresolved).toBeDefined();
      expect(['PENDING', 'RUNNING', 'FAILED']).toContain(unresolved!.status);

      await exit;
      await expect(coordinator.destroyAll()).resolves.toBeUndefined();
      expect(acpLaunchCleanupRegistry.getState(ownerId!)).toBeUndefined();
    } finally {
      await exit;
      await coordinator.destroyAll().catch(() => undefined);
      warn.mockRestore();
    }
  }, 15_000);

  it('kills and verifies Windows descendants even after the adapter root has settled', async () => {
    let rootPid = 0;
    const alive = new Set<number>([9902]);
    const terminateTree = vi.fn(async (pid: number) => {
      alive.delete(pid);
    });
    const windowsProcessAdapter: WindowsProcessTreeAdapter = {
      captureProcess: async (pid) => {
        rootPid = pid;
        return { pid, parentPid: 1, birthMarker: 'root-birth' };
      },
      captureDescendants: async () => [
        { pid: 9902, parentPid: rootPid, birthMarker: 'descendant-birth' },
      ],
      isProcessAlive: async (identity) => alive.has(identity.pid),
      terminateTree,
    };
    const manager = managerFor('setTimeout(() => process.exit(0), 20)', {}, {
      platform: 'win32',
      windowsProcessAdapter,
    });
    await manager.start();
    await waitForExit(manager);

    await expect(manager.stop()).resolves.toMatchObject({ exitCode: 0 });
    expect(terminateTree).toHaveBeenCalledWith(9902);
  });

  it('accepts a settled Windows child when no descendant remains observable', async () => {
    const terminateTree = vi.fn(async () => undefined);
    const windowsProcessAdapter: WindowsProcessTreeAdapter = {
      captureProcess: async () => null,
      captureDescendants: async () => [],
      isProcessAlive: async () => false,
      terminateTree,
    };
    const manager = managerFor('setTimeout(() => process.exit(0), 20)', {}, {
      platform: 'win32',
      windowsProcessAdapter,
    });

    const streams = await manager.start();
    await waitForExit(manager);

    await expect(manager.stop()).resolves.toMatchObject({ exitCode: 0 });
    expect(streams.birthMarker).toMatch(/^settled:/);
    expect(terminateTree).not.toHaveBeenCalled();
  });

  it.each(['missing', 'throwing'])('retains a retry owner when Windows live identity probe is %s', async (mode) => {
    let probeFails = true;
    const windowsProcessAdapter: WindowsProcessTreeAdapter = {
      captureProcess: async () => {
        if (probeFails && mode === 'throwing') throw new Error('CIM unavailable');
        return null;
      },
      captureDescendants: async () => [],
      isProcessAlive: async () => true,
      terminateTree: vi.fn(async () => undefined),
    };
    const manager = managerFor('setTimeout(() => process.exit(0), 500)', {}, {
      platform: 'win32',
      windowsProcessAdapter,
    });
    const exit = waitForExit(manager);

    await expect(manager.start()).rejects.toBeDefined();
    const ownerId = manager.getPostSpawnCleanupOwnerId();
    expect(ownerId).toBeTruthy();
    expect(acpLaunchCleanupRegistry.getState(ownerId!)).toMatchObject({
      status: 'FAILED',
      attemptCount: 3,
    });
    probeFails = false;
    await exit;
    await acpLaunchCleanupRegistry.runAttemptById(ownerId!);
    expect(acpLaunchCleanupRegistry.getState(ownerId!)).toBeUndefined();
  });

  it('quarantines a Windows launch when the root disappeared before descendants were observed', async () => {
    let rootVisible = true;
    let rootPid = 0;
    const survivingUnobservedChild = 9903;
    const alive = new Set<number>([survivingUnobservedChild]);
    const terminateTree = vi.fn(async (pid: number) => {
      alive.delete(pid);
    });
    const windowsProcessAdapter: WindowsProcessTreeAdapter = {
      captureProcess: async (pid) => {
        rootPid = pid;
        return rootVisible ? { pid, parentPid: 1, birthMarker: 'root-birth' } : null;
      },
      captureDescendants: async () => [
        { pid: survivingUnobservedChild, parentPid: rootPid, birthMarker: 'child-birth' },
      ],
      isProcessAlive: async (identity) => alive.has(identity.pid),
      terminateTree,
    };
    const manager = managerFor('setTimeout(() => process.exit(0), 20)', {}, {
      platform: 'win32',
      windowsProcessAdapter,
    });
    await manager.start();
    await waitForExit(manager);
    rootVisible = false;

    await expect(manager.stop()).rejects.toMatchObject({ code: 'process_identity_mismatch' });
    expect(terminateTree).not.toHaveBeenCalled();
    expect(alive.has(survivingUnobservedChild)).toBe(true);
    const ownerId = manager.getPostSpawnCleanupOwnerId();
    expect(ownerId).toBeTruthy();
    expect(acpLaunchCleanupRegistry.getState(ownerId!)).toBeDefined();
    rootVisible = true;
    await acpLaunchCleanupRegistry.drain();
    if (acpLaunchCleanupRegistry.getState(ownerId!)) {
      await acpLaunchCleanupRegistry.runAttemptById(ownerId!);
    }
    expect(acpLaunchCleanupRegistry.getState(ownerId!)).toBeUndefined();
  });

  it('recovers a persisted Unix ownership token without an in-memory manager', async () => {
    let alive = true;
    const member = {
      pid: 7302,
      pgid: 7301,
      birthIdentity: 'linux:123:owner-token',
      ownershipToken: 'owner-token',
    };
    const unixProcessAdapter = {
      captureProcess: vi.fn(async () => null),
      captureDescendantGroups: vi.fn(async () => []),
      captureOwnedGroups: vi.fn(async () => [{ pgid: 7301, members: [member] }]),
      isProcessAlive: vi.fn(async () => false),
      isProcessGroupAlive: vi.fn(async () => alive),
      signalProcess: vi.fn(async () => false),
      signalProcessGroup: vi.fn(async () => {
        alive = false;
        return true;
      }),
    };

    await cleanupPersistedAcpProcessTree({
      pid: 7301,
      processGroupId: '7301',
      birthMarker: 'linux:122:owner-token',
      ownershipToken: 'owner-token',
    }, {
      platform: 'linux',
      unixProcessAdapter,
      graceMs: 10,
    });

    expect(unixProcessAdapter.captureOwnedGroups).toHaveBeenCalledWith('owner-token');
    expect(unixProcessAdapter.signalProcessGroup).toHaveBeenCalled();
  });

  it('refuses persisted Unix cleanup when ownership cannot be enumerated', async () => {
    await expect(cleanupPersistedAcpProcessTree({
      pid: 7303,
      processGroupId: '7303',
      birthMarker: 'linux:124:owner-unverifiable',
      ownershipToken: 'owner-unverifiable',
    }, {
      platform: 'linux',
      unixProcessAdapter: {
        captureProcess: vi.fn(async () => null),
        captureDescendantGroups: vi.fn(async () => []),
        isProcessAlive: vi.fn(async () => false),
        isProcessGroupAlive: vi.fn(async () => false),
        signalProcess: vi.fn(async () => false),
        signalProcessGroup: vi.fn(async () => false),
      },
    })).rejects.toMatchObject({ code: 'process_identity_mismatch' });
  });

  it('does not treat Unix process enumeration failure as an empty owned tree', async () => {
    const signalProcessGroup = vi.fn(async () => true);
    await expect(cleanupPersistedAcpProcessTree({
      pid: 7304,
      processGroupId: '7304',
      birthMarker: 'linux:125:owner-enumeration-failure',
      ownershipToken: 'owner-enumeration-failure',
    }, {
      platform: 'linux',
      unixProcessAdapter: {
        captureProcess: vi.fn(async () => null),
        captureDescendantGroups: vi.fn(async () => []),
        captureOwnedGroups: vi.fn(async () => { throw new Error('ps unavailable'); }),
        isProcessAlive: vi.fn(async () => false),
        isProcessGroupAlive: vi.fn(async () => false),
        signalProcess: vi.fn(async () => false),
        signalProcessGroup,
      },
    })).rejects.toThrow('ps unavailable');
    expect(signalProcessGroup).not.toHaveBeenCalled();
  });

  it('does not treat Windows process enumeration failure as an empty owned tree', async () => {
    const terminateTree = vi.fn(async () => undefined);
    await expect(cleanupPersistedAcpProcessTree({
      pid: 7404,
      birthMarker: 'root-enumeration-failure',
      ownershipToken: 'owner-windows-enumeration-failure',
    }, {
      platform: 'win32',
      windowsProcessAdapter: {
        captureProcess: vi.fn(async () => { throw new Error('CIM unavailable'); }),
        captureDescendants: vi.fn(async () => []),
        isProcessAlive: vi.fn(async () => true),
        terminateTree,
      },
    })).rejects.toThrow('CIM unavailable');
    expect(terminateTree).not.toHaveBeenCalled();
  });

  it('refuses persisted Windows descendants after the recorded root disappeared', async () => {
    const alive = new Set([7402]);
    const terminateTree = vi.fn(async (pid: number) => {
      alive.delete(pid);
    });
    const windowsProcessAdapter: WindowsProcessTreeAdapter = {
      captureProcess: vi.fn(async () => null),
      captureDescendants: vi.fn(async () => [
        { pid: 7402, parentPid: 7401, birthMarker: 'descendant-birth' },
      ]),
      isProcessAlive: vi.fn(async (identity) => alive.has(identity.pid)),
      terminateTree,
    };

    await expect(cleanupPersistedAcpProcessTree({
      pid: 7401,
      processGroupId: '7401',
      birthMarker: 'root-birth',
      ownershipToken: 'owner-windows',
    }, {
      platform: 'win32',
      windowsProcessAdapter,
      graceMs: 10,
    })).rejects.toMatchObject({ code: 'process_identity_mismatch' });

    expect(terminateTree).not.toHaveBeenCalled();
  });

  it('does not touch a reused Windows root pid during persisted cleanup', async () => {
    const terminateTree = vi.fn(async () => undefined);
    const windowsProcessAdapter: WindowsProcessTreeAdapter = {
      captureProcess: vi.fn(async (pid) => ({ pid, parentPid: 1, birthMarker: 'new-root-birth' })),
      captureDescendants: vi.fn(async () => [
        { pid: 7502, parentPid: 7501, birthMarker: 'unrelated-child' },
      ]),
      isProcessAlive: vi.fn(async () => true),
      terminateTree,
    };

    await expect(cleanupPersistedAcpProcessTree({
      pid: 7501,
      processGroupId: '7501',
      birthMarker: 'old-root-birth',
      ownershipToken: 'owner-old-windows',
    }, {
      platform: 'win32',
      windowsProcessAdapter,
      graceMs: 10,
    })).rejects.toMatchObject({ code: 'process_identity_mismatch' });
    expect(terminateTree).not.toHaveBeenCalled();
  });
});

async function captureOwnedIdentity(
  adapter: ReturnType<typeof createUnixProcessIdentityAdapter>,
  ownershipToken: string,
  pid: number,
): Promise<UnixProcessIdentity | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const groups = await adapter.captureOwnedGroups?.(ownershipToken);
    const identity = groups?.flatMap((group) => group.members).find((member) => member.pid === pid);
    if (identity) return identity;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

async function waitForIdentityExit(
  adapter: ReturnType<typeof createUnixProcessIdentityAdapter>,
  identity: UnixProcessIdentity,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!await adapter.isProcessAlive(identity)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Test cleanup could not confirm process ${identity.pid} exited`);
}
