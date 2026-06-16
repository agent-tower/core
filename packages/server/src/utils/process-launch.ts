import os from 'node:os';
import path from 'node:path';

export interface CommandInvocation {
  command: string;
  args: string[];
}

export function getNodeRuntimeCommand(): string {
  return process.env.AGENT_TOWER_NODE_RUNTIME || process.execPath;
}

const PTY_WRAPPER_SCRIPT = String.raw`
const { spawn } = require('node:child_process');
const { createReadStream, unlink } = require('node:fs');

const [mode, programPath, ...rest] = process.argv.slice(1);
const isWin = process.platform === 'win32';
const isCmdBat = isWin && /\.(cmd|bat)$/i.test(programPath);
const internalEnvKeys = ['AGENT_TOWER_NODE_RUNTIME', 'ELECTRON_RUN_AS_NODE'];

let child;
let cleanupTarget = null;
const sentSignals = new Set();
let forceKillTimer = null;

function getChildEnv() {
  const env = { ...process.env };
  for (const key of internalEnvKeys) {
    delete env[key];
  }
  return env;
}

function cleanup() {
  if (!cleanupTarget) return;
  const target = cleanupTarget;
  cleanupTarget = null;
  unlink(target, () => {});
}

// 终止 child 及其整个进程组。
// Unix 下 child 以 detached 启动（pgid === child.pid），组播信号可覆盖
// child 派生的整棵子树（pnpm dev、tsc --watch 等），防止孙进程被 init
// 收养成为孤儿。同一信号只发送一次；进程组已消失时退回单进程击杀。
// Windows 没有进程组信号语义，维持单进程击杀。
function killTree(signal) {
  if (!child || sentSignals.has(signal)) return;
  sentSignals.add(signal);
  if (isWin) {
    if (!child.killed) {
      try { child.kill(signal); } catch {}
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    if (!child.killed) {
      try { child.kill(signal); } catch {}
    }
  }
}

// 收到终止信号后兜底：5 秒内进程组未退干净则升级为 SIGKILL。
function scheduleForceKill() {
  if (forceKillTimer) return;
  forceKillTimer = setTimeout(() => {
    killTree('SIGKILL');
  }, 5000);
  if (forceKillTimer.unref) forceKillTimer.unref();
}

function exitWithChildResult(code, signal) {
  cleanup();
  // child 已退出：清扫其进程组内残留的后台孙进程（dev server、watch 等）。
  // SIGHUP 与 PTY 关闭语义一致；组内无进程时 killTree 内部忽略 ESRCH。
  killTree('SIGHUP');
  if (typeof code === 'number') {
    process.exit(code);
  }
  if (signal) {
    process.exit(1);
  }
  process.exit(0);
}

function exitWithError(error) {
  cleanup();
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

function escapeArgForCmd(arg) {
  if (/[\s"&|<>^()!]/.test(arg) || arg === '') {
    return '"' + arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return arg;
}

function spawnCmd(args, stdioOpt) {
  const cmdLine = [programPath, ...args].map(escapeArgForCmd).join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/s', '/c', '"' + cmdLine + '"'], {
    stdio: stdioOpt,
    env: getChildEnv(),
    windowsVerbatimArguments: true,
  });
}

// Unix: detached 使 child 自成进程组组长，便于整组击杀。
// stdio 继承的 PTY fd 不受影响（isatty 仍为 true）；终止信号统一由
// 本 wrapper 经 killTree 显式转发。Windows 下 detached 会脱离 ConPTY，
// 保持默认行为。
function spawnChild(args, stdioOpt) {
  return spawn(programPath, args, { stdio: stdioOpt, detached: !isWin, env: getChildEnv() });
}

if (mode === 'pipe-file') {
  const [stdinFile, ...args] = rest;
  cleanupTarget = stdinFile;
  child = isCmdBat
    ? spawnCmd(args, ['pipe', 'inherit', 'inherit'])
    : spawnChild(args, ['pipe', 'inherit', 'inherit']);

  child.on('error', exitWithError);
  child.on('exit', exitWithChildResult);

  const stream = createReadStream(stdinFile);
  stream.on('error', (error) => {
    killTree('SIGTERM');
    exitWithError(error);
  });
  stream.pipe(child.stdin);
  stream.on('end', () => {
    if (child.stdin) {
      child.stdin.end();
    }
  });
} else {
  child = isCmdBat
    ? spawnCmd(rest, 'inherit')
    : spawnChild(rest, 'inherit');

  child.on('error', exitWithError);
  child.on('exit', exitWithChildResult);
}

['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => {
  process.on(signal, () => {
    killTree(signal);
    scheduleForceKill();
  });
});
`;

export function getBundledPrismaCommand(moduleDir: string): CommandInvocation {
  return {
    command: getNodeRuntimeCommand(),
    args: [path.resolve(moduleDir, '../node_modules/prisma/build/index.js')],
  };
}

export function buildPtyCommand(programPath: string, args: string[]): CommandInvocation {
  return {
    command: getNodeRuntimeCommand(),
    args: ['-e', PTY_WRAPPER_SCRIPT, 'spawn', programPath, ...args],
  };
}

export function buildPtyCommandWithStdin(
  programPath: string,
  args: string[],
  stdinFile: string
): CommandInvocation {
  return {
    command: getNodeRuntimeCommand(),
    args: ['-e', PTY_WRAPPER_SCRIPT, 'pipe-file', programPath, stdinFile, ...args],
  };
}

export function getDefaultTerminalShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): CommandInvocation {
  if (platform === 'win32') {
    return {
      command: env.ComSpec || env.COMSPEC || 'cmd.exe',
      args: [],
    };
  }

  return {
    command: env.SHELL || '/bin/zsh',
    args: [],
  };
}

export function getPtyLogFilePath(tmpDir: string = os.tmpdir()): string {
  return path.join(tmpDir, 'agent-tower-pty.log');
}

export function normalizeCommandLookupOutput(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  // On Windows, `where` may return multiple hits (e.g. `claude`, `claude.cmd`,
  // `claude.ps1`). The extensionless POSIX shim is not directly executable by
  // Node's child_process.spawn, so prefer .cmd/.bat/.exe which the PTY wrapper
  // can handle correctly (with `shell: true` for .cmd/.bat, or natively for .exe).
  if (process.platform === 'win32' && lines.length > 1) {
    const preferred = lines.find((l) => /\.(cmd|bat|exe)$/i.test(l));
    if (preferred) return preferred;
  }

  return lines[0];
}
