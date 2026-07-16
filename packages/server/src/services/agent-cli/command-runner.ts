import { execFile } from 'node:child_process';
import {
  buildWindowsCmdShimCommandLine,
  normalizeCommandLookupOutput,
  withUnixUserPathFallbacks,
  withWindowsUserPathFallbacks,
} from '../../utils/process-launch.js';
import type { AgentCliCommandSpec, AgentCliPlatform } from '@agent-tower/shared';
import { buildCleanAgentCliEnv } from './security.js';

export interface AgentCliExecFileResult {
  stdout: string
  stderr: string
}

export type AgentCliExecFile = (
  command: string,
  args: string[],
  options: {
    timeout: number
    maxBuffer: number
    env: NodeJS.ProcessEnv
    shell: false
    windowsHide: true
    encoding: 'utf8'
  }
) => Promise<AgentCliExecFileResult>;

const DEFAULT_MAX_BUFFER = 256 * 1024;
const WINDOWS_LOOKUP_TIMEOUT_MS = 5000;

export function defaultExecFile(
  command: string,
  args: string[],
  options: Parameters<AgentCliExecFile>[2]
): Promise<AgentCliExecFileResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export function isCommandMissing(error: unknown): boolean {
  return !!(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
  );
}

function commandMissingError(command: string): Error & { code: 'ENOENT' } {
  return Object.assign(new Error(`Executable '${command}' not found in PATH`), { code: 'ENOENT' as const });
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

async function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  execFileImpl: AgentCliExecFile
): Promise<string> {
  if (hasPathSeparator(command) || /\.(?:cmd|bat|exe)$/i.test(command)) {
    return command;
  }

  let result: AgentCliExecFileResult;
  try {
    result = await execFileImpl('where', [command], {
      timeout: WINDOWS_LOOKUP_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER,
      env,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
    });
  } catch {
    throw commandMissingError(command);
  }
  const resolved = normalizeCommandLookupOutput(result.stdout, 'win32');
  if (!resolved) throw commandMissingError(command);
  return resolved;
}

function buildWindowsCommand(command: string, args: string[], env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  if (!/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args };
  }

  return {
    command: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${buildWindowsCmdShimCommandLine(command, args)}"`],
  };
}

export async function runAgentCliCommand(
  spec: AgentCliCommandSpec,
  options: {
    execFileImpl?: AgentCliExecFile
    platform?: AgentCliPlatform | null
    env?: NodeJS.ProcessEnv
  } = {}
): Promise<AgentCliExecFileResult> {
  const execFileImpl = options.execFileImpl ?? defaultExecFile;
  const platform = options.platform ?? (
    process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
      ? process.platform
      : null
  );
  let env = options.env ?? buildCleanAgentCliEnv(undefined, platform);
  if (platform === 'win32') {
    env = withWindowsUserPathFallbacks(env);
  } else if (platform === 'darwin' || platform === 'linux') {
    env = withUnixUserPathFallbacks(env, platform);
  }

  let command = spec.command;
  let args = [...spec.args];

  if (platform === 'win32') {
    command = await resolveWindowsCommand(command, env, execFileImpl);
    ({ command, args } = buildWindowsCommand(command, args, env));
  }

  return execFileImpl(command, args, {
    timeout: spec.timeoutMs,
    maxBuffer: DEFAULT_MAX_BUFFER,
    env,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
  });
}
