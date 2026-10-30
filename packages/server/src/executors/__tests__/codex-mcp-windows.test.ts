import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as ChildProcess from 'child_process';
import {
  buildAgentTowerMcpConfigOverrides,
  getCodexMcpServerNamesForLaunch,
  resetCodexMcpServerCache,
} from '../codex.executor.js';
import { ExecutionEnv } from '../execution-env.js';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof ChildProcess>(),
  execFile: mocks.execFile,
}));

const nativePlatform = process.platform;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-windows-'));
const workingDir = path.join(tmpDir, 'project with spaces');
const codexHome = path.join(tmpDir, 'codex-home');
fs.mkdirSync(path.join(workingDir, '.codex'), { recursive: true });
fs.mkdirSync(codexHome);
fs.writeFileSync(path.join(workingDir, '.codex', 'config.toml'), '[mcp_servers.agent-tower]\ncommand="old-tower"');

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  resetCodexMcpServerCache();
  mocks.execFile.mockReset();
  mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
    callback(null, JSON.stringify([{ name: 'agent-tower' }, { name: 'project-only' }]));
  });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  resetCodexMcpServerCache();
});
afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { CODEX_HOME: codexHome, PROVIDER_SENTINEL: 'provider-value', ...overrides };
}

describe('Windows Codex MCP launch discovery', () => {
  it.each(['cmd', 'BAT'])('loads project MCPs through a .%s shim with cwd, env and config arguments', async extension => {
    const executable = path.join(tmpDir, `npm directory/codex.${extension}`);
    const env = environment({ ComSpec: 'custom-cmd.exe' });
    const overrides = ['--profile', 'work profile', '-c', 'model="test model"'];

    const names = await getCodexMcpServerNamesForLaunch(
      overrides, undefined, { program: executable, args: overrides }, env, workingDir,
    );

    expect(names).toEqual(new Set(['agent-tower', 'project-only']));
    expect(mocks.execFile).toHaveBeenCalledOnce();
    const [command, args, options] = mocks.execFile.mock.calls[0]!;
    expect(command).toBe('custom-cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(args[3]).toContain('codex.' + extension);
    expect(args[3]).toContain('--profile "work profile"');
    expect(args[3]).toContain('-c "model=\\"test model\\""');
    expect(args[3]).toMatch(/ mcp list --json"$/);
    expect(options).toMatchObject({
      cwd: fs.realpathSync(workingDir), env, timeout: 3000, windowsHide: true, windowsVerbatimArguments: true,
    });
    expect(options.shell).not.toBe(true);

    const sessionEnv = ExecutionEnv.default(workingDir).merge({
      AGENT_TOWER_AGENT_CREDENTIAL: 'windows-session-credential',
      AGENT_TOWER_URL: 'http://127.0.0.1:42001',
      AGENT_TOWER_SESSION_ID: 'windows-mcp-session',
    });
    expect(buildAgentTowerMcpConfigOverrides(sessionEnv, names)).toContain('mcp_servers.agent-tower.enabled=false');
  });

  it.each(['ComSpec', 'COMSPEC', undefined])('selects the configured command interpreter (%s)', async key => {
    const env = environment(key ? { [key]: 'selected-cmd.exe' } : {});
    await getCodexMcpServerNamesForLaunch([], undefined, { program: path.join(tmpDir, 'codex.cmd'), args: [] }, env, workingDir);
    expect(mocks.execFile.mock.calls[0]![0]).toBe(key ? 'selected-cmd.exe' : 'cmd.exe');
  });

  it('resolves an npm shim from a Windows Path variable', async () => {
    const binDir = path.join(tmpDir, 'npm-bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'codex.CMD'), '');
    const env = environment({ Path: binDir, PATHEXT: '.EXE;.CMD;.BAT' });

    await getCodexMcpServerNamesForLaunch([], undefined, { program: 'codex', args: [] }, env, workingDir);

    expect(mocks.execFile.mock.calls[0]![0]).toBe('cmd.exe');
    expect(mocks.execFile.mock.calls[0]![1][3]).toContain('codex.CMD');
  });

  it('retains a relative custom shim and resolves it from the target workspace', async () => {
    await getCodexMcpServerNamesForLaunch([], undefined, { program: './tools/custom-codex.cmd', args: ['--profile', 'custom'] }, environment(), workingDir);
    const args = mocks.execFile.mock.calls[0]![1];
    expect(args[3]).toContain('custom-codex.cmd');
    // cmd quoting escapes Windows path separators; normalize only for this assertion.
    expect(args[3].replace(/\\\\/g, '\\')).toContain(path.join(workingDir, 'tools', 'custom-codex.cmd'));
    expect(args[3]).toContain('--profile custom mcp list --json');
  });

  it('keeps native executables and missing custom commands on the direct path', async () => {
    for (const program of [path.join(tmpDir, 'native codex.exe'), 'custom-missing-codex']) {
      const args = ['-c', 'model="test model"'];
      await getCodexMcpServerNamesForLaunch(args, undefined, { program, args }, environment(), workingDir);
      expect(mocks.execFile).toHaveBeenLastCalledWith(program, [...args, 'mcp', 'list', '--json'],
        expect.not.objectContaining({ windowsVerbatimArguments: true }), expect.any(Function));
    }
  });

  it('retains the existing global fallback if the command interpreter fails', async () => {
    const configPath = path.join(tmpDir, 'fallback.toml');
    fs.writeFileSync(configPath, '[mcp_servers.global-only]\ncommand="fallback-mcp"');
    mocks.execFile.mockImplementation((_command, _args, _options, callback) => callback(new Error('interpreter failed'), ''));

    const names = await getCodexMcpServerNamesForLaunch([], configPath, { program: path.join(tmpDir, 'codex.cmd'), args: [] }, environment(), workingDir);
    expect(names).toEqual(new Set(['global-only']));
  });

  it('does not wrap a .cmd filename on Unix', async () => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
    const executable = path.join(tmpDir, 'unix-codex.cmd');
    await getCodexMcpServerNamesForLaunch([], undefined, { program: executable, args: [] }, environment(), workingDir);
    expect(mocks.execFile).toHaveBeenCalledWith(executable, ['mcp', 'list', '--json'],
      expect.not.objectContaining({ windowsVerbatimArguments: true }), expect.any(Function));
  });
});

describe.skipIf(nativePlatform !== 'win32')('native Windows npm shim discovery', () => {
  it.each(['cmd', 'bat'])('round-trips project configuration and arguments through a real .%s shim', async extension => {
    const nativeChildProcess = await vi.importActual<typeof ChildProcess>('child_process');
    mocks.execFile.mockImplementation(nativeChildProcess.execFile);
    const script = path.join(tmpDir, 'native-probe.cjs');
    const captured = path.join(tmpDir, `native-args-${extension}.json`);
    fs.writeFileSync(script, [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), sentinel: process.env.PROVIDER_SENTINEL}));`,
      'const config = fs.readFileSync(".codex/config.toml", "utf8");',
      'process.stdout.write(JSON.stringify(config.includes("mcp_servers.agent-tower") ? [{name:"agent-tower"}] : []));',
    ].join('\n'));
    const shim = path.join(tmpDir, `native codex.${extension}`);
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const args = ['-c', 'model="test model"'];

    const env = environment({ ...process.env, CODEX_HOME: codexHome });
    const names = await getCodexMcpServerNamesForLaunch(args, undefined, { program: shim, args }, env, workingDir);

    expect(names).toEqual(new Set(['agent-tower']));
    expect(JSON.parse(fs.readFileSync(captured, 'utf8'))).toEqual({
      args: [...args, 'mcp', 'list', '--json'], cwd: fs.realpathSync(workingDir), sentinel: 'provider-value',
    });
  });
});
