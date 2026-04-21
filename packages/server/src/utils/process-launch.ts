import os from 'node:os';
import path from 'node:path';

export interface CommandInvocation {
  command: string;
  args: string[];
}

const PTY_WRAPPER_SCRIPT = String.raw`
const { spawn } = require('node:child_process');
const { createReadStream, unlink } = require('node:fs');

const [mode, programPath, ...rest] = process.argv.slice(1);
const isCmdBat = process.platform === 'win32' && /\.(cmd|bat)$/i.test(programPath);

let child;
let cleanupTarget = null;

function cleanup() {
  if (!cleanupTarget) return;
  const target = cleanupTarget;
  cleanupTarget = null;
  unlink(target, () => {});
}

function exitWithChildResult(code, signal) {
  cleanup();
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
    windowsVerbatimArguments: true,
  });
}

if (mode === 'pipe-file') {
  const [stdinFile, ...args] = rest;
  cleanupTarget = stdinFile;
  child = isCmdBat
    ? spawnCmd(args, ['pipe', 'inherit', 'inherit'])
    : spawn(programPath, args, { stdio: ['pipe', 'inherit', 'inherit'] });

  child.on('error', exitWithError);
  child.on('exit', exitWithChildResult);

  const stream = createReadStream(stdinFile);
  stream.on('error', (error) => {
    if (child && !child.killed) {
      child.kill();
    }
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
    : spawn(programPath, rest, { stdio: 'inherit' });

  child.on('error', exitWithError);
  child.on('exit', exitWithChildResult);
}

['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => {
  process.on(signal, () => {
    if (child && !child.killed) {
      child.kill(signal);
    }
  });
});
`;

export function getBundledPrismaCommand(moduleDir: string): CommandInvocation {
  return {
    command: process.execPath,
    args: [path.resolve(moduleDir, '../node_modules/prisma/build/index.js')],
  };
}

export function buildPtyCommand(programPath: string, args: string[]): CommandInvocation {
  return {
    command: process.execPath,
    args: ['-e', PTY_WRAPPER_SCRIPT, 'spawn', programPath, ...args],
  };
}

export function buildPtyCommandWithStdin(
  programPath: string,
  args: string[],
  stdinFile: string
): CommandInvocation {
  return {
    command: process.execPath,
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
