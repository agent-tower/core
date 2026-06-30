import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentCliDownloadedScriptInstall } from '@agent-tower/shared';
import { AgentCliDownloader } from '../downloader.js';
import { AgentCliEnvironmentService } from '../environment.service.js';
import { validateAgentCliManifestItem } from '../manifest-validator.js';
import { getAgentCliManifestItem } from '../manifest.js';

let tempDir = '';

const install: AgentCliDownloadedScriptInstall = {
  kind: 'downloaded-script',
  downloadUrl: 'https://example.com/install.sh',
  allowedRedirectHosts: ['example.com', 'cdn.example.com'],
  allowedExactPaths: ['/install.sh', '/scripts/install.sh'],
  allowedPathPrefixes: [],
  interpreters: {
    darwin: { command: '/bin/sh', args: [] },
  },
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
    const invalid = {
      ...codex!,
      install: {
        ...install,
        fixedArgs: ['| bash'],
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
      downloadUrl: expect.any(String),
      allowedRedirectHosts: expect.any(Array),
      allowedExactPaths: expect.any(Array),
      allowedPathPrefixes: expect.any(Array),
      interpreters: expect.any(Object),
      fixedArgs: expect.any(Array),
      maxBytes: expect.any(Number),
      riskNotes: expect.any(Array),
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
