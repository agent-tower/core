import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentCliDownloadedScriptInstallSpec,
  AgentCliInstallManifestItem,
  AgentCliPlatform,
  AgentCliToolId,
} from '@agent-tower/shared';
import { AgentCliDownloader } from '../downloader.js';
import { AgentCliEnvironmentService } from '../environment.service.js';
import { validateAgentCliManifestItem } from '../manifest-validator.js';
import { getAgentCliManifestItem } from '../manifest.js';

let tempDir = '';

const install: AgentCliDownloadedScriptInstallSpec = {
  downloadUrl: 'https://example.com/install.sh',
  allowedRedirectHosts: ['example.com', 'cdn.example.com'],
  allowedExactPaths: ['/install.sh', '/scripts/install.sh'],
  allowedPathPrefixes: [],
  scriptExtension: '.sh',
  interpreter: { command: '/bin/sh', args: [] },
  fixedArgs: [],
  maxBytes: 1024,
  riskNotes: ['test installer'],
  verifyCommand: {
    command: 'tool',
    args: ['--version'],
    timeoutMs: 5000,
  },
};

function makeResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

function getDownloadedScriptInstall(
  toolId: AgentCliToolId,
  platform: AgentCliPlatform
): AgentCliDownloadedScriptInstallSpec {
  const item = getAgentCliManifestItem(toolId);
  expect(item?.install.kind).toBe('downloaded-script');
  if (item?.install.kind !== 'downloaded-script') {
    throw new Error(`Expected downloaded-script install spec for ${toolId}`);
  }
  const platformInstall = item.install.platforms[platform];
  expect(platformInstall).toBeTruthy();
  if (!platformInstall) {
    throw new Error(`Expected ${platform} install spec for ${toolId}`);
  }
  return platformInstall;
}

const codexUnixReleaseAssetUrl = 'https://release-assets.githubusercontent.com/github-production-release-asset/965415649/test-id?response-content-disposition=attachment%3B%20filename%3Dinstall.sh';
const claudeUnixBootstrapUrl = 'https://downloads.claude.ai/claude-code-releases/bootstrap.sh';

function makeOfficialUnixFetch(
  toolId: 'codex' | 'claude-code',
  fetchCalls: string[] = []
): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = input.toString();
    fetchCalls.push(url);
    if (toolId === 'codex') {
      if (url === 'https://chatgpt.com/codex/install.sh') {
        return makeResponse('', {
          status: 302,
          headers: { location: 'https://github.com/openai/codex/releases/latest/download/install.sh' },
        });
      }
      if (url === 'https://github.com/openai/codex/releases/latest/download/install.sh') {
        return makeResponse('', {
          status: 302,
          headers: { location: 'https://github.com/openai/codex/releases/download/rust-v0.142.5/install.sh' },
        });
      }
      if (url === 'https://github.com/openai/codex/releases/download/rust-v0.142.5/install.sh') {
        return makeResponse('', {
          status: 302,
          headers: { location: codexUnixReleaseAssetUrl },
        });
      }
      return makeResponse('#!/bin/sh\necho codex ok\n');
    }

    if (url === 'https://claude.ai/install.sh') {
      return makeResponse('', {
        status: 302,
        headers: { location: claudeUnixBootstrapUrl },
      });
    }
    return makeResponse('#!/bin/bash\necho claude ok\n');
  }) as typeof fetch;
}

describe('Agent CLI manifest validator and downloader', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-downloader-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects manifest shell metacharacters instead of accepting curl pipe strings', () => {
    const codex = getAgentCliManifestItem('codex');
    expect(codex).toBeTruthy();
    const invalid: AgentCliInstallManifestItem = {
      ...codex!,
      install: {
        kind: 'downloaded-script',
        platforms: {
          darwin: {
            ...install,
            fixedArgs: ['| bash'],
          },
        },
      },
    };

    expect(() => validateAgentCliManifestItem(invalid)).toThrow(/shell metacharacters/);
  });

  it('returns public manifest items without internal verify commands', () => {
    const service = new AgentCliEnvironmentService({ platform: 'darwin' });
    const manifest = service.getManifest();
    const codex = manifest.find((item) => item.id === 'codex');

    expect(codex).toBeTruthy();
    expect(codex?.install.kind).toBe('downloaded-script');
    expect(codex?.install).toMatchObject({
      kind: 'downloaded-script',
      platforms: {
        darwin: {
          downloadUrl: expect.any(String),
          allowedRedirectHosts: expect.any(Array),
          allowedExactPaths: expect.any(Array),
          allowedPathPrefixes: expect.any(Array),
          scriptExtension: '.sh',
          interpreter: expect.any(Object),
          fixedArgs: expect.any(Array),
          maxBytes: expect.any(Number),
          riskNotes: expect.any(Array),
        },
      },
    });
    expect(JSON.stringify(manifest)).not.toContain('verifyCommand');
  });

  it('downloads through validated HTTPS redirect chain and writes a 0600 temp file', async () => {
    const fetchCalls: string[] = [];
    const downloader = new AgentCliDownloader({
      tmpDir: tempDir,
      fetchImpl: (async (input: URL | RequestInfo) => {
        const url = input.toString();
        fetchCalls.push(url);
        if (url === 'https://example.com/install.sh') {
          return makeResponse('', {
            status: 302,
            headers: { location: 'https://cdn.example.com/scripts/install.sh' },
          });
        }
        return makeResponse('#!/bin/sh\necho ok\n');
      }) as typeof fetch,
    });

    const preview = await downloader.createPreview('codex', 'darwin', install);

    expect(fetchCalls).toEqual([
      'https://example.com/install.sh',
      'https://cdn.example.com/scripts/install.sh',
    ]);
    expect(preview.redirectChain).toHaveLength(2);
    expect(preview.finalUrl).toBe('https://cdn.example.com/scripts/install.sh');
    expect(preview.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(preview.tempFilePath)).toBe(true);
    expect((fs.statSync(preview.tempFilePath).mode & 0o777)).toBe(0o600);
  });

  it('writes Windows PowerShell previews with .ps1 extension and fixed interpreter argv', async () => {
    const downloader = new AgentCliDownloader({
      tmpDir: tempDir,
      fetchImpl: (async () => makeResponse('Write-Output "ok"\n')) as typeof fetch,
    });
    const windowsInstall: AgentCliDownloadedScriptInstallSpec = {
      ...install,
      downloadUrl: 'https://example.com/install.ps1',
      allowedExactPaths: ['/install.ps1'],
      scriptExtension: '.ps1',
      interpreter: {
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'],
      },
      env: { CODEX_NON_INTERACTIVE: '1' },
    };

    const preview = await downloader.createPreview('codex', 'win32', windowsInstall);

    expect(path.extname(preview.tempFilePath)).toBe('.ps1');
    expect(preview.interpreter).toEqual({
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'],
    });
    expect(preview.env).toEqual({ CODEX_NON_INTERACTIVE: '1' });
  });

  it.each(['darwin', 'linux'] as const)(
    'allows the expected Codex Unix official redirect chain on %s through the environment service',
    async (platform) => {
      const fetchCalls: string[] = [];
      const service = new AgentCliEnvironmentService({
        platform,
        downloaderOptions: {
          tmpDir: tempDir,
          fetchImpl: makeOfficialUnixFetch('codex', fetchCalls),
        },
      });

      const preview = await service.createPreview('codex');

      expect(fetchCalls).toEqual([
        'https://chatgpt.com/codex/install.sh',
        'https://github.com/openai/codex/releases/latest/download/install.sh',
        'https://github.com/openai/codex/releases/download/rust-v0.142.5/install.sh',
        codexUnixReleaseAssetUrl,
      ]);
      expect(preview.platform).toBe(platform);
      expect(preview.finalUrl).toBe(codexUnixReleaseAssetUrl);
      expect(preview.redirectChain).toHaveLength(4);
    },
  );

  it.each(['darwin', 'linux'] as const)(
    'allows the expected Claude Unix official redirect chain on %s through the environment service',
    async (platform) => {
      const service = new AgentCliEnvironmentService({
        platform,
        downloaderOptions: {
          tmpDir: tempDir,
          fetchImpl: makeOfficialUnixFetch('claude-code'),
        },
      });

      const preview = await service.createPreview('claude-code');

      expect(preview.platform).toBe(platform);
      expect(preview.finalUrl).toBe(claudeUnixBootstrapUrl);
      expect(preview.redirectChain.map((step) => step.url)).toEqual([
        'https://claude.ai/install.sh',
        claudeUnixBootstrapUrl,
      ]);
    },
  );

  it('allows the expected Codex Windows official redirect chain', async () => {
    const codex = getAgentCliManifestItem('codex');
    expect(codex?.install.kind).toBe('downloaded-script');
    const install = codex?.install.kind === 'downloaded-script'
      ? codex.install.platforms.win32
      : undefined;
    expect(install).toBeTruthy();

    const fetchCalls: string[] = [];
    const downloader = new AgentCliDownloader({
      tmpDir: tempDir,
      fetchImpl: (async (input: URL | RequestInfo) => {
        const url = input.toString();
        fetchCalls.push(url);
        if (url === 'https://chatgpt.com/codex/install.ps1') {
          return makeResponse('', {
            status: 302,
            headers: { location: 'https://github.com/openai/codex/releases/latest/download/install.ps1' },
          });
        }
        if (url === 'https://github.com/openai/codex/releases/latest/download/install.ps1') {
          return makeResponse('', {
            status: 302,
            headers: { location: 'https://github.com/openai/codex/releases/download/rust-v0.142.5/install.ps1' },
          });
        }
        if (url === 'https://github.com/openai/codex/releases/download/rust-v0.142.5/install.ps1') {
          return makeResponse('', {
            status: 302,
            headers: {
              location: 'https://release-assets.githubusercontent.com/github-production-release-asset/965415649/test-id?response-content-disposition=attachment%3B%20filename%3Dinstall.ps1',
            },
          });
        }
        return makeResponse('Write-Output "codex ok"\n');
      }) as typeof fetch,
    });

    const preview = await downloader.createPreview('codex', 'win32', install!);

    expect(fetchCalls).toEqual([
      'https://chatgpt.com/codex/install.ps1',
      'https://github.com/openai/codex/releases/latest/download/install.ps1',
      'https://github.com/openai/codex/releases/download/rust-v0.142.5/install.ps1',
      'https://release-assets.githubusercontent.com/github-production-release-asset/965415649/test-id?response-content-disposition=attachment%3B%20filename%3Dinstall.ps1',
    ]);
    expect(preview.finalUrl).toBe('https://release-assets.githubusercontent.com/github-production-release-asset/965415649/test-id?response-content-disposition=attachment%3B%20filename%3Dinstall.ps1');
  });

  it('allows the expected Claude Windows official redirect chain', async () => {
    const claude = getAgentCliManifestItem('claude-code');
    expect(claude?.install.kind).toBe('downloaded-script');
    const install = claude?.install.kind === 'downloaded-script'
      ? claude.install.platforms.win32
      : undefined;
    expect(install).toBeTruthy();

    const downloader = new AgentCliDownloader({
      tmpDir: tempDir,
      fetchImpl: (async (input: URL | RequestInfo) => {
        const url = input.toString();
        if (url === 'https://claude.ai/install.ps1') {
          return makeResponse('', {
            status: 302,
            headers: { location: 'https://downloads.claude.ai/claude-code-releases/bootstrap.ps1' },
          });
        }
        return makeResponse('Write-Output "claude ok"\n');
      }) as typeof fetch,
    });

    const preview = await downloader.createPreview('claude-code', 'win32', install!);

    expect(preview.finalUrl).toBe('https://downloads.claude.ai/claude-code-releases/bootstrap.ps1');
  });

  it('rejects Codex Windows redirects outside the official release paths', async () => {
    const codex = getAgentCliManifestItem('codex');
    const install = codex?.install.kind === 'downloaded-script'
      ? codex.install.platforms.win32
      : undefined;
    expect(install).toBeTruthy();
    const downloader = new AgentCliDownloader({
      tmpDir: tempDir,
      fetchImpl: (async () => makeResponse('', {
        status: 302,
        headers: { location: 'https://github.com/openai/not-codex/releases/download/v1/install.ps1' },
      })) as typeof fetch,
    });

    await expect(downloader.createPreview('codex', 'win32', install!))
      .rejects.toThrow(/path is not allowlisted/);
  });

  it('rejects Claude Windows redirects outside the bootstrap script path', async () => {
    const claude = getAgentCliManifestItem('claude-code');
    const install = claude?.install.kind === 'downloaded-script'
      ? claude.install.platforms.win32
      : undefined;
    expect(install).toBeTruthy();
    const downloader = new AgentCliDownloader({
      tmpDir: tempDir,
      fetchImpl: (async () => makeResponse('', {
        status: 302,
        headers: { location: 'https://downloads.claude.ai/other/bootstrap.ps1' },
      })) as typeof fetch,
    });

    await expect(downloader.createPreview('claude-code', 'win32', install!))
      .rejects.toThrow(/path is not allowlisted/);
  });

  it.each(['darwin', 'linux'] as const)(
    'rejects Codex Unix redirects outside the official release paths on %s',
    async (platform) => {
      const platformInstall = getDownloadedScriptInstall('codex', platform);
      const downloader = new AgentCliDownloader({
        tmpDir: tempDir,
        fetchImpl: (async () => makeResponse('', {
          status: 302,
          headers: { location: 'https://github.com/openai/not-codex/releases/download/v1/install.sh' },
        })) as typeof fetch,
      });

      await expect(downloader.createPreview('codex', platform, platformInstall))
        .rejects.toThrow(/path is not allowlisted/);
    },
  );

  it.each(['darwin', 'linux'] as const)(
    'rejects Claude Unix redirects outside the bootstrap script path on %s',
    async (platform) => {
      const platformInstall = getDownloadedScriptInstall('claude-code', platform);
      const downloader = new AgentCliDownloader({
        tmpDir: tempDir,
        fetchImpl: (async () => makeResponse('', {
          status: 302,
          headers: { location: 'https://downloads.claude.ai/other/bootstrap.sh' },
        })) as typeof fetch,
      });

      await expect(downloader.createPreview('claude-code', platform, platformInstall))
        .rejects.toThrow(/path is not allowlisted/);
    },
  );

  it.each([
    ['codex', 'darwin'],
    ['codex', 'linux'],
    ['claude-code', 'darwin'],
    ['claude-code', 'linux'],
  ] as const)(
    'rejects %s Unix redirects to non-allowlisted hosts on %s',
    async (toolId, platform) => {
      const platformInstall = getDownloadedScriptInstall(toolId, platform);
      const downloader = new AgentCliDownloader({
        tmpDir: tempDir,
        fetchImpl: (async () => makeResponse('', {
          status: 302,
          headers: { location: 'https://evil.example/install.sh' },
        })) as typeof fetch,
      });

      await expect(downloader.createPreview(toolId, platform, platformInstall))
        .rejects.toThrow(/host is not allowlisted/);
    },
  );

  it('rejects redirects to non-allowlisted hosts', async () => {
    const downloader = new AgentCliDownloader({
      tmpDir: tempDir,
      fetchImpl: (async () => makeResponse('', {
        status: 302,
        headers: { location: 'https://evil.example/install.sh' },
      })) as typeof fetch,
    });

    await expect(downloader.createPreview('codex', 'darwin', install))
      .rejects.toThrow(/host is not allowlisted/);
  });

  it('rejects redirects with userinfo', async () => {
    const downloader = new AgentCliDownloader({
      tmpDir: tempDir,
      fetchImpl: (async () => makeResponse('', {
        status: 302,
        headers: { location: 'https://user:pass@example.com/install.sh' },
      })) as typeof fetch,
    });

    await expect(downloader.createPreview('codex', 'darwin', install))
      .rejects.toThrow(/userinfo/);
  });

  it('rejects scripts above the configured size limit', async () => {
    const downloader = new AgentCliDownloader({
      tmpDir: tempDir,
      fetchImpl: (async () => makeResponse('x'.repeat(1025))) as typeof fetch,
    });

    await expect(downloader.createPreview('codex', 'darwin', install))
      .rejects.toThrow(/size limit/);
  });
});
