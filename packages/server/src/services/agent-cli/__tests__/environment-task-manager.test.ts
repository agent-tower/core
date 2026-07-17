import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliInstallPreview } from '@agent-tower/shared';
import { AgentCliEnvironmentService } from '../environment.service.js';
import { AgentCliInstallTaskManager, type AgentCliRunnerProcess } from '../task-manager.js';
import type { AgentCliStoredPreview } from '../downloader.js';

let tempDir = '';

function makeStoredPreview(overrides: Partial<AgentCliStoredPreview> = {}): AgentCliStoredPreview {
  const dir = fs.mkdtempSync(path.join(tempDir, 'preview-'));
  const file = path.join(dir, 'install.sh');
  fs.writeFileSync(file, '#!/bin/sh\necho ok\n', { mode: 0o600 });
  const now = new Date();
  const preview: AgentCliStoredPreview = {
    id: 'preview-1',
    toolId: 'codex',
    platform: 'darwin',
    status: 'ready',
    finalUrl: 'https://example.com/install.sh',
    redirectChain: [],
    sizeBytes: 18,
    sha256: 'a'.repeat(64),
    interpreter: { command: '/bin/sh', args: [] },
    fixedArgs: [],
    riskNotes: [],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    tempFilePath: file,
    verifyCommand: {
      command: 'codex',
      args: ['--version'],
      timeoutMs: 5000,
      versionPattern: String.raw`\d+\.\d+\.\d+`,
    },
    ...overrides,
  };
  return preview;
}

class FakeProcess extends EventEmitter implements AgentCliRunnerProcess {
  pid = 12345;
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  killedSignals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedSignals.push(signal);
    return true;
  }
}

describe('Agent CLI preview lifecycle and task manager', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-task-test-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('expires previews and removes temp files before installation', async () => {
    const preview = makeStoredPreview({
      expiresAt: '2026-06-18T00:00:01.000Z',
    });
    const file = preview.tempFilePath;
    const service = new AgentCliEnvironmentService({
      platform: 'darwin',
      now: () => new Date('2026-06-18T00:00:02.000Z'),
      downloader: {
        createPreview: vi.fn(async () => preview),
      } as never,
    });

    const publicPreview = await service.createPreview('codex');
    expect((publicPreview as AgentCliInstallPreview).id).toBe('preview-1');

    await expect(service.createTask('preview-1')).rejects.toMatchObject({
      code: 'AGENT_CLI_PREVIEW_EXPIRED',
    });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('limits running installs globally and removes unused duplicate preview files', async () => {
    const first = makeStoredPreview({ id: 'preview-1' });
    const second = makeStoredPreview({ id: 'preview-2' });
    const secondPath = second.tempFilePath;
    const process = new FakeProcess();
    const runner = vi.fn(() => process);
    const manager = new AgentCliInstallTaskManager(runner, undefined, vi.fn(async () => {}));

    const created = manager.createTask(first);
    const reused = manager.createTask(second);

    expect(created.reused).toBe(false);
    expect(reused.reused).toBe(true);
    expect(reused.task.id).toBe(created.task.id);
    expect(runner).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(fs.existsSync(secondPath)).toBe(false);
    });
  });

  it('redacts logs before returning ring buffer entries', () => {
    const preview = makeStoredPreview();
    const process = new FakeProcess();
    const manager = new AgentCliInstallTaskManager(() => process, undefined, vi.fn(async () => {}));
    const { task } = manager.createTask(preview);

    process.stdout.emit('data', Buffer.from('OPENAI_API_KEY=sk-proj_123'));
    process.stdout.emit('data', Buffer.from('4567890abcdef\n'));
    process.stderr.emit('data', Buffer.from('Authorization: Bearer abcdef'));
    process.stderr.emit('data', Buffer.from('1234567890\n'));

    const logs = manager.getLogs(task.id, 0);
    const text = logs.entries.map((entry) => entry.data).join('\n');

    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('sk-proj_1234567890abcdef');
    expect(text).not.toContain('abcdef1234567890');
  });

  it('does not leak long newline-free token tails after redaction overflow flushes', () => {
    const preview = makeStoredPreview();
    const process = new FakeProcess();
    const manager = new AgentCliInstallTaskManager(() => process, undefined, vi.fn(async () => {}));
    const { task } = manager.createTask(preview);
    const token = 'a'.repeat(520);

    process.stdout.emit('data', Buffer.from(`Bearer ${token}`));
    process.emit('exit', 1, null);

    const text = manager.getLogs(task.id, 0).entries.map((entry) => entry.data).join('\n');
    expect(text).toContain('[log line exceeded redaction window; partial content withheld]');
    expect(text).not.toContain(token.slice(-128));
    expect(text).not.toContain(`Bearer ${token}`);
  });

  it('cancels by signalling the process group and only marks cancelled after exit', async () => {
    vi.useFakeTimers();
    const preview = makeStoredPreview();
    const process = new FakeProcess();
    const processKill = vi.spyOn(process, 'kill');
    const groupKill = vi.spyOn(globalThis.process, 'kill').mockImplementation(() => true);
    const manager = new AgentCliInstallTaskManager(() => process, 100, vi.fn(async () => {}));
    const { task } = manager.createTask(preview);

    try {
      const cancelling = manager.cancel(task.id);
      expect(cancelling.status).toBe('cancelling');
      expect(manager.getTask(task.id).status).toBe('cancelling');
      expect(groupKill).toHaveBeenCalledWith(-process.pid, 'SIGTERM');
      expect(groupKill).toHaveBeenCalledWith(-process.pid, 'SIGHUP');
      expect(processKill).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(groupKill).toHaveBeenCalledWith(-process.pid, 'SIGKILL');

      process.emit('exit', null, 'SIGTERM');

      expect(manager.getTask(task.id)).toMatchObject({
        status: 'cancelled',
        signal: 'SIGTERM',
      });
      await vi.waitFor(() => {
        expect(fs.existsSync(preview.tempFilePath)).toBe(false);
      });
    } finally {
      groupKill.mockRestore();
      processKill.mockRestore();
    }
  });

  it('executes fixed interpreter, temp script path and fixed args only', () => {
    const preview = makeStoredPreview({
      interpreter: { command: '/bin/bash', args: ['-e'] },
      fixedArgs: ['--stable'],
    });
    const process = new FakeProcess();
    const runner = vi.fn(() => process);
    const manager = new AgentCliInstallTaskManager(runner, undefined, vi.fn(async () => {}));

    manager.createTask(preview);

    expect(runner).toHaveBeenCalledWith(
      '/bin/bash',
      ['-e', preview.tempFilePath, '--stable'],
      expect.objectContaining({ detached: expect.any(Boolean), stdio: 'pipe' }),
    );
  });

  it('provides the Windows platform marker required by official PowerShell installers', () => {
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\alice\\AppData\\Local');
    const preview = makeStoredPreview({
      platform: 'win32',
      interpreter: {
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'],
      },
    });
    const process = new FakeProcess();
    const runner = vi.fn(() => process);
    const manager = new AgentCliInstallTaskManager(runner, undefined, vi.fn(async () => {}));

    manager.createTask(preview);

    expect(runner).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', preview.tempFilePath],
      expect.objectContaining({
        env: expect.objectContaining({
          OS: 'Windows_NT',
          PATH: expect.stringContaining('C:\\Users\\alice\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin'),
        }),
      }),
    );
  });

  it('moves to verifying after installer exits 0 and succeeds only after verify passes', async () => {
    const preview = makeStoredPreview();
    const process = new FakeProcess();
    let resolveVerify!: () => void;
    const verifier = vi.fn(() => new Promise<void>((resolve) => {
      resolveVerify = resolve;
    }));
    const manager = new AgentCliInstallTaskManager(() => process, undefined, verifier);
    const { task } = manager.createTask(preview);

    process.emit('exit', 0, null);

    await vi.waitFor(() => {
      expect(manager.getTask(task.id).status).toBe('verifying');
    });
    expect(verifier).toHaveBeenCalledWith(preview.verifyCommand);

    resolveVerify();

    await vi.waitFor(() => {
      expect(manager.getTask(task.id).status).toBe('succeeded');
    });
  });

  it('marks failed when installer exits 0 but verify fails without leaking verify output', async () => {
    const preview = makeStoredPreview();
    const process = new FakeProcess();
    const verifier = vi.fn(async () => {
      throw new Error('verify stdout OPENAI_API_KEY=sk-proj_verifysecret stderr Bearer verifysecret');
    });
    const manager = new AgentCliInstallTaskManager(() => process, undefined, verifier);
    const { task } = manager.createTask(preview);

    process.emit('exit', 0, null);

    await vi.waitFor(() => {
      expect(manager.getTask(task.id)).toMatchObject({
        status: 'failed',
        errorCode: 'VERIFY_FAILED',
        errorMessage: 'Installer verification failed',
      });
    });

    const text = manager.getLogs(task.id).entries.map((entry) => entry.data).join('\n');
    expect(text).toContain('Installer verification failed');
    expect(text).not.toContain('verify stdout');
    expect(text).not.toContain('sk-proj_verifysecret');
    expect(text).not.toContain('verifysecret');
  });

  it('can cancel while verifying without signalling the exited installer process', async () => {
    const preview = makeStoredPreview();
    const process = new FakeProcess();
    const processKill = vi.spyOn(process, 'kill');
    let resolveVerify!: () => void;
    const verifier = vi.fn(() => new Promise<void>((resolve) => {
      resolveVerify = resolve;
    }));
    const manager = new AgentCliInstallTaskManager(() => process, undefined, verifier);
    const { task } = manager.createTask(preview);

    process.emit('exit', 0, null);

    await vi.waitFor(() => {
      expect(manager.getTask(task.id).status).toBe('verifying');
    });

    const cancelling = manager.cancel(task.id);
    expect(cancelling.status).toBe('cancelling');
    expect(processKill).not.toHaveBeenCalled();

    resolveVerify();

    await vi.waitFor(() => {
      expect(manager.getTask(task.id).status).toBe('cancelled');
    });
  });
});
