import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const VERSION_PROBE_TIMEOUT_MS = 5_000;

/**
 * `originator` and `user-agent` prefix used by non-interactive `codex exec`.
 *
 * Agent Tower drives Codex through the ACP adapter, which otherwise identifies
 * itself as `@agentclientprotocol/codex-acp` in the `user-agent` header.
 * Some OpenAI-compatible gateways only accept traffic that looks like the
 * native Codex CLI, so the identity is rewritten to match `codex exec`.
 */
export const CODEX_CLI_ORIGINATOR = 'codex_exec';

/** Terminal name Codex reports when it cannot detect a terminal at all. */
const UNKNOWN_TERMINAL = 'unknown';

const versionCache = new Map<string, Promise<string | undefined>>();
let platformDescription: Promise<string> | undefined;

/** Cache probe results for the lifetime of the process; the runtime rarely changes. */
export function resetCodexCliIdentityCache(): void {
  versionCache.clear();
  platformDescription = undefined;
}

/**
 * Full `user-agent` value a native `codex exec` process would send.
 *
 * Format verified against Codex CLI 0.156.0:
 * `{name}/{codexVersion} ({platform}) {terminal} ({name}; {clientVersion})`
 * e.g. `codex_exec/0.156.0 (Mac OS 15.6.1; arm64) Apple_Terminal/455.1 (codex_exec; 0.156.0)`
 */
export function formatCodexCliUserAgent(parts: {
  clientName: string;
  codexVersion: string;
  platform: string;
  terminal: string;
  clientVersion: string;
}): string {
  return `${parts.clientName}/${parts.codexVersion} (${parts.platform}) ${parts.terminal}`
    + ` (${parts.clientName}; ${parts.clientVersion})`;
}

/**
 * Terminal segment of the Codex user-agent.
 *
 * Codex prefers `TERM_PROGRAM`, then falls back to well-known session markers
 * and finally reports `unknown`; verified against Codex CLI 0.156.0.
 */
export function detectCodexTerminal(environment: NodeJS.ProcessEnv): string {
  const program = environment.TERM_PROGRAM?.trim();
  if (program) {
    const version = environment.TERM_PROGRAM_VERSION?.trim();
    return version ? `${program}/${version}` : program;
  }
  if (environment.WT_SESSION?.trim()) return 'WindowsTerminal';
  if (environment.TERM_SESSION_ID?.trim()) return 'Apple_Terminal';
  return UNKNOWN_TERMINAL;
}

/** Architecture token as reported by the Rust `os_info` crate Codex uses. */
function describeArchitecture(): string {
  switch (process.arch) {
    case 'x64':
      return 'x86_64';
    case 'ia32':
      return 'i686';
    default:
      return process.arch;
  }
}

/** `Mac OS 15.6.1; arm64` — the parenthesised segment of the Codex user-agent. */
export async function resolveCodexPlatformDescription(): Promise<string> {
  platformDescription ??= buildPlatformDescription();
  return await platformDescription;
}

async function buildPlatformDescription(): Promise<string> {
  const architecture = describeArchitecture();
  if (process.platform === 'darwin') {
    return `Mac OS ${await readMacOsProductVersion()}; ${architecture}`;
  }
  if (process.platform === 'linux') {
    return `${await readLinuxDistributionName()}; ${architecture}`;
  }
  if (process.platform === 'win32') {
    return `Windows ${os.release()}; ${architecture}`;
  }
  return `${process.platform}; ${architecture}`;
}

async function readMacOsProductVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('sw_vers', ['-productVersion'], {
      encoding: 'utf8',
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    const version = String(stdout).trim();
    if (version) return version;
  } catch {
    // Fall through to the Darwin kernel mapping below.
  }
  // Darwin 24.6.0 -> macOS 15.6.0; the kernel release omits the patch version.
  const [major, minor] = os.release().split('.');
  const macosMajor = Number(major);
  if (Number.isFinite(macosMajor) && macosMajor >= 20) {
    return `${macosMajor - 9}.${minor ?? '0'}.0`;
  }
  return os.release();
}

async function readLinuxDistributionName(): Promise<string> {
  try {
    const contents = await readFile('/etc/os-release', 'utf8');
    const fields = new Map<string, string>();
    for (const line of contents.split('\n')) {
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^"|"$/g, ''));
    }
    const name = fields.get('NAME');
    const version = fields.get('VERSION_ID');
    if (name && version) return `${name} ${version}`;
    if (name) return name;
  } catch {
    // Unknown distributions keep the generic platform name.
  }
  return 'Linux';
}

/**
 * Resolve `codex --version` for the binary Agent Tower is about to launch.
 *
 * Best effort: callers must tolerate `undefined` and leave headers untouched.
 */
export async function resolveCodexVersion(
  codexPath: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (!codexPath) return undefined;
  const cached = versionCache.get(codexPath);
  if (cached) return await cached;
  const pending = probeCodexVersion(codexPath, environment);
  versionCache.set(codexPath, pending);
  return await pending;
}

async function probeCodexVersion(
  codexPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(codexPath, ['--version'], {
      encoding: 'utf8',
      timeout: VERSION_PROBE_TIMEOUT_MS,
      env: environment,
      windowsHide: true,
      // `.cmd` shims on Windows are not directly executable without a shell.
      shell: process.platform === 'win32',
    });
    return parseCodexVersion(String(stdout));
  } catch {
    return undefined;
  }
}

/** `codex-cli 0.156.0` -> `0.156.0` */
export function parseCodexVersion(output: string): string | undefined {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return match?.[1];
}

/**
 * Build the `user-agent` that makes an ACP-launched Codex indistinguishable
 * from a native `codex exec` process, or `undefined` when the runtime version
 * cannot be determined.
 */
export async function resolveCodexCliUserAgent(options: {
  codexPath: string | undefined;
  environment: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const codexVersion = await resolveCodexVersion(options.codexPath, options.environment);
  if (!codexVersion) return undefined;
  return formatCodexCliUserAgent({
    clientName: CODEX_CLI_ORIGINATOR,
    codexVersion,
    platform: await resolveCodexPlatformDescription(),
    terminal: detectCodexTerminal(options.environment),
    clientVersion: codexVersion,
  });
}
