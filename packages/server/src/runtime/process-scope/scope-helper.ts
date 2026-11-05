import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCOPE_HELPER_PROTOCOL_VERSION = 1;

export interface ScopeHelperCapabilities {
  /** The supervisor can become a child subreaper (required). */
  subreaper: boolean;
  /** pidfd_open/pidfd_send_signal are available, so a reused PID is never signalled. */
  pidfd: boolean;
  /** /proc/<pid>/task/<tid>/children is available; otherwise members are found by one /proc pass at stop time. */
  childrenFile: boolean;
}

export interface ScopeHelper {
  path: string;
  capabilities: ScopeHelperCapabilities;
}

// `src/runtime/process-scope` and `dist/runtime/process-scope` both sit three
// levels below the package root, where `prebuilds/` lives in dev and in the
// published package.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function defaultScopeHelperPath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform !== 'linux') return null;
  return path.join(packageRoot, 'prebuilds', `${platform}-${arch}`, 'agent-tower-scope');
}

/**
 * Runs the supervisor's `--probe` once. A binary that cannot become a
 * subreaper on this kernel is treated as absent so callers fall back to the
 * compatibility backend instead of trusting an incomplete scope.
 */
export function probeScopeHelper(helperPath: string): ScopeHelper | null {
  try {
    accessSync(helperPath, constants.X_OK);
  } catch {
    return null;
  }
  let output: string;
  try {
    output = execFileSync(helperPath, ['--probe'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { version, subreaper, pidfd, childrenFile } = parsed as Record<string, unknown>;
  if (version !== SCOPE_HELPER_PROTOCOL_VERSION || subreaper !== true) return null;
  return {
    path: helperPath,
    capabilities: { subreaper: true, pidfd: pidfd === true, childrenFile: childrenFile === true },
  };
}

let cached: { key: string; helper: ScopeHelper | null } | undefined;

/**
 * Resolves the supervisor for this host. `AGENT_TOWER_PROCESS_SCOPE=compat`
 * forces the compatibility backend; `AGENT_TOWER_SCOPE_HELPER_PATH` points at
 * a binary outside the bundled `prebuilds/` directory. Linux only.
 */
export function resolveScopeHelper(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ScopeHelper | null {
  if (platform !== 'linux') return null;
  if (process.env.AGENT_TOWER_PROCESS_SCOPE === 'compat') return null;
  const helperPath = process.env.AGENT_TOWER_SCOPE_HELPER_PATH || defaultScopeHelperPath(platform, arch);
  if (!helperPath) return null;
  if (cached?.key === helperPath) return cached.helper;
  const helper = probeScopeHelper(helperPath);
  cached = { key: helperPath, helper };
  return helper;
}

export function resetScopeHelperCache(): void {
  cached = undefined;
}
