import { execFile } from 'node:child_process';
import type {
  AgentCliCommandSpec,
  AgentCliEnvironmentStatus,
  AgentCliInstallManifestItem,
  AgentCliPlatform,
  AgentCliToolStatus,
} from '@agent-tower/shared';
import { buildCleanAgentCliEnv, parseWhitelistedVersion } from './security.js';

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

function defaultExecFile(
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

function isCommandMissing(error: unknown): boolean {
  return !!(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
  );
}

export class AgentCliDetector {
  private cache: AgentCliEnvironmentStatus | null = null;

  constructor(
    private readonly execFileImpl: AgentCliExecFile = defaultExecFile,
    private readonly platform: AgentCliPlatform | null
  ) {}

  getCachedStatus(manifest: AgentCliInstallManifestItem[]): AgentCliEnvironmentStatus {
    if (this.cache) return this.cache;
    return {
      tools: manifest.map((item) => ({
        toolId: item.id,
        installStatus: 'unknown',
        versionStatus: 'unknown',
        version: null,
        authStatus: 'unknown',
        checkedAt: null,
        stale: true,
      })),
      checkedAt: null,
      stale: true,
    };
  }

  async refresh(manifest: AgentCliInstallManifestItem[]): Promise<AgentCliEnvironmentStatus> {
    const checkedAt = new Date().toISOString();
    const tools: AgentCliToolStatus[] = [];

    for (const item of manifest) {
      tools.push(await this.detectTool(item, checkedAt));
    }

    this.cache = {
      tools,
      checkedAt,
      stale: false,
    };
    return this.cache;
  }

  async runCommand(spec: AgentCliCommandSpec): Promise<AgentCliExecFileResult> {
    return this.execFileImpl(spec.command, [...spec.args], {
      timeout: spec.timeoutMs,
      maxBuffer: DEFAULT_MAX_BUFFER,
      env: buildCleanAgentCliEnv(),
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
    });
  }

  private async detectTool(
    item: AgentCliInstallManifestItem,
    checkedAt: string
  ): Promise<AgentCliToolStatus> {
    if (!this.platform || !item.supportedPlatforms.includes(this.platform)) {
      return {
        toolId: item.id,
        installStatus: 'unsupported',
        versionStatus: 'unavailable',
        version: null,
        authStatus: 'unknown',
        checkedAt,
        stale: false,
      };
    }

    const detection = await this.findSuccessfulCommand(item.detectionCommands);
    if (!detection.success) {
      return {
        toolId: item.id,
        installStatus: 'missing',
        versionStatus: 'unavailable',
        version: null,
        authStatus: 'unknown',
        checkedAt,
        stale: false,
        errorCode: detection.errorCode,
      };
    }

    const version = item.versionCommand
      ? await this.readVersion(item.versionCommand)
      : parseWhitelistedVersion(`${detection.result.stdout}\n${detection.result.stderr}`);

    const authStatus = item.authCommand
      ? await this.readAuthStatus(item.authCommand)
      : 'unknown';

    return {
      toolId: item.id,
      installStatus: item.legacy ? 'legacy_detected' : 'installed',
      versionStatus: version ? 'detected' : 'unknown',
      version,
      authStatus,
      checkedAt,
      stale: false,
    };
  }

  private async findSuccessfulCommand(specs: AgentCliCommandSpec[]): Promise<
    | { success: true; result: AgentCliExecFileResult }
    | { success: false; errorCode?: string }
  > {
    let nonMissingFailure = false;
    for (const spec of specs) {
      try {
        const result = await this.runCommand(spec);
        return { success: true, result };
      } catch (error) {
        if (!isCommandMissing(error)) {
          nonMissingFailure = true;
        }
      }
    }
    return { success: false, errorCode: nonMissingFailure ? 'DETECTION_FAILED' : undefined };
  }

  private async readVersion(spec: AgentCliCommandSpec): Promise<string | null> {
    try {
      const result = await this.runCommand(spec);
      return parseWhitelistedVersion(`${result.stdout}\n${result.stderr}`, spec.versionPattern);
    } catch {
      return null;
    }
  }

  private async readAuthStatus(spec: AgentCliCommandSpec): Promise<AgentCliToolStatus['authStatus']> {
    try {
      await this.runCommand(spec);
      return 'detected';
    } catch (error) {
      return isCommandMissing(error) ? 'unknown' : 'needs_interactive_login';
    }
  }
}
