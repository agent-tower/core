import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentCliCommandSpec,
  AgentCliDownloadedScriptInstall,
  AgentCliInstallPreview,
  AgentCliPlatform,
  AgentCliRedirectStep,
  AgentCliToolId,
} from '@agent-tower/shared';
import { ValidationError } from '../../errors.js';

export interface AgentCliStoredPreview extends AgentCliInstallPreview {
  tempFilePath: string
  verifyCommand: AgentCliCommandSpec
}

export interface AgentCliDownloadOptions {
  fetchImpl?: typeof fetch
  tmpDir?: string
  now?: () => Date
  ttlMs?: number
  maxRedirects?: number
}

const DEFAULT_PREVIEW_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_REDIRECTS = 3;

function normalizeHost(host: string): string {
  return host.toLowerCase();
}

function assertAllowedUrl(url: URL, install: AgentCliDownloadedScriptInstall): void {
  if (url.protocol !== 'https:') {
    throw new ValidationError('Installer download URL must use HTTPS');
  }
  if (url.username || url.password) {
    throw new ValidationError('Installer download URL must not include userinfo');
  }

  const allowedHosts = new Set(install.allowedRedirectHosts.map(normalizeHost));
  if (!allowedHosts.has(normalizeHost(url.hostname))) {
    throw new ValidationError(`Installer download host is not allowlisted: ${url.hostname}`);
  }

  const exact = install.allowedExactPaths.includes(url.pathname);
  const prefixed = install.allowedPathPrefixes.some((prefix) => (
    prefix !== '' && url.pathname.startsWith(prefix)
  ));
  if (!exact && !prefixed) {
    throw new ValidationError(`Installer download path is not allowlisted: ${url.pathname}`);
  }
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new ValidationError('Installer script exceeds configured size limit');
  }

  const chunks: Buffer[] = [];
  let total = 0;

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new ValidationError('Installer script exceeds configured size limit');
    }
    return buffer;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new ValidationError('Installer script exceeds configured size limit');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

export class AgentCliDownloader {
  private readonly fetchImpl: typeof fetch;
  private readonly tmpDir: string;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxRedirects: number;

  constructor(options: AgentCliDownloadOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tmpDir = options.tmpDir ?? os.tmpdir();
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? DEFAULT_PREVIEW_TTL_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  }

  async createPreview(
    toolId: AgentCliToolId,
    platform: AgentCliPlatform,
    install: AgentCliDownloadedScriptInstall
  ): Promise<AgentCliStoredPreview> {
    let current = new URL(install.downloadUrl);
    const redirectChain: AgentCliRedirectStep[] = [];
    let response: Response | null = null;

    for (let index = 0; index <= this.maxRedirects; index += 1) {
      assertAllowedUrl(current, install);
      response = await this.fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
      });

      redirectChain.push({
        url: current.toString(),
        host: current.hostname,
        path: current.pathname,
        statusCode: response.status,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new ValidationError('Installer redirect missing location header');
        }
        current = new URL(location, current);
        if (index === this.maxRedirects) {
          throw new ValidationError('Installer download exceeded redirect limit');
        }
        continue;
      }

      break;
    }

    if (!response || !response.ok) {
      throw new ValidationError(`Installer download failed with status ${response?.status ?? 'unknown'}`);
    }

    assertAllowedUrl(current, install);
    const script = await readLimitedBody(response, install.maxBytes);
    const sha256 = createHash('sha256').update(script).digest('hex');

    const tempDir = await fs.promises.mkdtemp(path.join(this.tmpDir, 'agent-tower-agent-cli-'));
    const tempFilePath = path.join(tempDir, `${toolId}-${randomUUID()}.sh`);
    await fs.promises.writeFile(tempFilePath, script, { mode: 0o600 });
    await fs.promises.chmod(tempFilePath, 0o600);

    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    const interpreter = install.interpreters[platform];
    if (!interpreter) {
      await removePreviewFile(tempFilePath);
      throw new ValidationError(`Installer is unsupported on platform: ${platform}`);
    }

    return {
      id: `agent-cli-preview-${randomUUID()}`,
      toolId,
      platform,
      status: 'ready',
      finalUrl: current.toString(),
      redirectChain,
      sizeBytes: script.byteLength,
      sha256,
      interpreter: {
        command: interpreter.command,
        args: [...interpreter.args],
      },
      fixedArgs: [...install.fixedArgs],
      riskNotes: [...install.riskNotes],
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      tempFilePath,
      verifyCommand: {
        ...install.verifyCommand,
        args: [...install.verifyCommand.args],
      },
    };
  }
}

export async function removePreviewFile(tempFilePath: string): Promise<void> {
  await fs.promises.rm(path.dirname(tempFilePath), { recursive: true, force: true });
}

export function toPublicPreview(preview: AgentCliStoredPreview): AgentCliInstallPreview {
  const {
    tempFilePath: _tempFilePath,
    verifyCommand: _verifyCommand,
    ...publicPreview
  } = preview;
  return publicPreview;
}
