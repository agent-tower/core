import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Provider } from '@agent-tower/shared';
import { which } from '../utils/index.js';
import { runOwnedCommand } from '../utils/owned-child-process.js';

export interface CodexCliSupport { supported: boolean; code?: string; message?: string; executable?: string; version?: string }
const unverified = (): CodexCliSupport => ({ supported: false, code: 'CAPABILITY_UNVERIFIED', message: 'This Codex executable/build/platform has not passed native app-server permission verification.' });
// Exact native build only. See the native probe record before adding another build/platform.
const VERIFIED = { platform: 'darwin', arch: 'arm64', version: '0.161.0', sha256: '12ac11d2c7eee27cfae34393986d7b7c9ed0dea537cb749831cdd7033893e6de' };
const verifiedEntrypointSha = '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70';
let cached: { key: string; result: Promise<CodexCliSupport> } | undefined;
let current: CodexCliSupport = unverified();

/** Unknown command/PATH overrides stay disabled rather than probing arbitrary wrappers. */
export function cachedCodexCliSupport(provider?: Pick<Provider, 'config' | 'env'>): CodexCliSupport {
  const cmd = provider?.config.cmd as { baseCommandOverride?: unknown; additionalParams?: unknown; env?: Record<string, string> } | undefined;
  if (cmd?.baseCommandOverride || (Array.isArray(cmd?.additionalParams) ? cmd.additionalParams.length > 0 : cmd?.additionalParams != null)
    || ['PATH', 'PATHEXT'].some(k => provider?.env?.[k] !== undefined || cmd?.env?.[k] !== undefined)) {
    return { ...unverified(), message: 'Codex custom commands, extra launch arguments and executable search overrides have not passed CLI permission verification.' };
  }
  return current;
}

export async function refreshCodexCliSupport(): Promise<CodexCliSupport> {
  try {
    if (process.platform !== VERIFIED.platform || process.arch !== VERIFIED.arch || process.versions.electron || process.env.AGENT_TOWER_DESKTOP_RUNTIME_MODE) return current = unverified();
    const found = await which('codex', { timeoutMs: 3000 });
    if (!found) return current = { supported: false, code: 'RUNTIME_MODE_UNSUPPORTED', message: 'Codex CLI is not installed.' };
    const entry = await realpath(found); const entryStat = await stat(entry);
    if (entryStat.size > 512 * 1024 * 1024) return current = unverified();
    let executable = entry;
    if (path.basename(entry) === 'codex.js') {
      if (createHash('sha256').update(await readFile(entry)).digest('hex') !== verifiedEntrypointSha) return current = unverified();
      const root = path.resolve(path.dirname(entry), '..');
      const candidates = [path.join(root, 'node_modules/@openai/codex-darwin-arm64'), path.resolve(root, '../codex-darwin-arm64')];
      executable = '';
      for (const candidate of candidates) {
        const native = path.join(candidate, 'vendor/aarch64-apple-darwin/bin/codex');
        try { executable = await realpath(native); break; } catch { /* Optional native package may be hoisted. */ }
      }
      if (!executable) return current = unverified();
    }
    const info = await stat(executable);
    const cacheKey = [entry, entryStat.ino, entryStat.size, entryStat.mtimeMs, entryStat.ctimeMs, executable, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
    if (cached?.key !== cacheKey) cached = { key: cacheKey, result: (async () => {
      if (info.size > 512 * 1024 * 1024 || createHash('sha256').update(await readFile(executable)).digest('hex') !== VERIFIED.sha256) return unverified();
      const { stdout } = await runOwnedCommand(executable, ['--version'], { timeout: 3000, maxBuffer: 4096 });
      return stdout.trim() === `codex-cli ${VERIFIED.version}` ? { supported: true, executable, version: VERIFIED.version } : unverified();
    })().catch(() => unverified()) };
    return current = await cached.result;
  } catch { return current = unverified(); }
}
