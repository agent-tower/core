import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Provider } from '@agent-tower/shared';
import { which } from '../utils/index.js';

export interface ClaudeCliAskSupport { supported: boolean; code?: string; message?: string; executable?: string; version?: string }
const unverified = (): ClaudeCliAskSupport => ({ supported: false, code: 'CAPABILITY_UNVERIFIED', message: 'This actual Claude executable/version/platform has not passed native CLI ASK verification.' });
// Enabled only after the recorded native allow/deny + resume smoke; no guessed semver range.
// This gate verifies the native control transport, not every model combination.
// initialize/default ACK precedes the user task; real tool smoke is deepseek-v4-pro only.
const VERIFIED_BUILDS: ReadonlyArray<{ platform: string; arch: string; version: string; sha256: string }> = [
  { platform: 'darwin', arch: 'arm64', version: '2.1.293', sha256: '4e21122a227857da1178aca3299700c1fd7f2b77c93f12e73c2c76db796a105e' },
];
const run = promisify(execFile);
let cached: { key: string; result: Promise<ClaudeCliAskSupport> } | undefined;
let current: ClaudeCliAskSupport = unverified();

export function cachedClaudeCliAskSupport(provider?: Pick<Provider, 'config' | 'env'>): ClaudeCliAskSupport {
  const cmd = provider?.config.cmd as { baseCommandOverride?: unknown; additionalParams?: unknown } | undefined;
  if (provider?.config.claudeCodeRouter || cmd?.baseCommandOverride || (Array.isArray(cmd?.additionalParams) ? cmd.additionalParams.length > 0 : cmd?.additionalParams != null)) return { ...unverified(), message: 'Claude router, custom commands and extra launch arguments have not passed CLI ASK verification.' };
  return current;
}
export async function refreshClaudeCliAskSupport(): Promise<ClaudeCliAskSupport> {
  try {
    if (process.versions.electron || process.env.AGENT_TOWER_DESKTOP_RUNTIME_MODE) return current = unverified();
    const executable = await which('claude', { timeoutMs: 3000 });
    if (!executable) return current = { supported: false, code: 'RUNTIME_MODE_UNSUPPORTED', message: 'Claude CLI is not installed.' };
    const resolved = await realpath(executable);
    const info = await stat(resolved);
    const key = [resolved, info.ino, info.size, info.mtimeMs, info.ctimeMs, process.platform, process.arch].join(':');
    if (cached?.key !== key) cached = { key, result: (async () => {
      // Never execute an unknown PATH wrapper just to populate a settings page.
      const candidates = VERIFIED_BUILDS.filter(build => build.platform === process.platform && build.arch === process.arch);
      if (!candidates.length || info.size > 512 * 1024 * 1024) return unverified();
      const digest = createHash('sha256').update(await readFile(resolved)).digest('hex');
      const candidate = candidates.find(build => build.sha256 === digest);
      if (!candidate) return unverified();
      const env = { ...process.env }; delete env.CLAUDECODE;
      const { stdout } = await run(executable, ['--version'], { timeout: 3000, maxBuffer: 4096, env });
      const version = /^(\d+\.\d+\.\d+) \(Claude Code\)/.exec(stdout.trim())?.[1];
      return version === candidate.version ? { supported: true, executable: resolved, version } : unverified();
    })().catch(() => unverified()) };
    return current = await cached.result;
  } catch { return current = unverified(); }
}
