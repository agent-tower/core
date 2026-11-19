/**
 * `GET /git/diff` over real HTTP: the answer shapes, `force`, and the abort
 * when the client goes away before the answer is sent. Runs in both
 * placements (default config: the git state service in this process;
 * `vitest.command-helper.config.ts`: in the command helper).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GitFileDiffResponse } from '@agent-tower/shared';
import { readRuntimeCounters } from '../../runtime/runtime-metrics.js';
import { commitAll, git, initRepo, isolateGitConfiguration, largeText, lines, settle, write } from '../../git/state/__tests__/git-fixtures.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-git-diff-route-'));
isolateGitConfiguration(root);
const repo = path.join(root, 'repo');
const worktree = path.join(root, 'worktree');
const slowScript = path.join(root, 'slow-textconv-route-marker.sh');
const slowPids = path.join(root, 'slow.pids');

vi.mock('../../git/workspace-git-target.js', () => ({
  resolveWorkspaceGitTarget: async () => ({ baseBranch: 'main', repositoryPath: repo }),
}));

let app: FastifyInstance;
let baseUrl = '';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const slowPidList = () => (fs.existsSync(slowPids) ? fs.readFileSync(slowPids, 'utf8').split('\n').filter(Boolean).map(Number) : []);

function url(query: Record<string, string>): string {
  return `${baseUrl}/api/git/diff?${new URLSearchParams({ workingDir: worktree, type: 'uncommitted', ...query })}`;
}

async function getJson(query: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url(query));
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  initRepo(repo);
  write(path.join(repo, 'a.txt'), lines(5, 'a'));
  write(path.join(repo, 'small.txt'), lines(5, 'small'));
  write(path.join(repo, 'slow.txt'), lines(3, 'slow'));
  write(path.join(repo, '.gitattributes'), 'slow.txt diff=slowconv\n');
  commitAll(repo, 'base');
  fs.writeFileSync(slowScript, [
    '#!/bin/sh',
    `echo $$ >> '${slowPids}'`,
    'i=0; while [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done',
    'cat "$1"',
    '',
  ].join('\n'), { mode: 0o755 });
  git(repo, 'config', 'diff.slowconv.textconv', slowScript);
  git(repo, 'worktree', 'add', '-q', '-b', 'topic', worktree, 'main');
  fs.appendFileSync(path.join(worktree, 'a.txt'), 'edited\n');
  write(path.join(worktree, 'small.txt'), largeText('grown', 1_500_000));
  fs.appendFileSync(path.join(worktree, 'slow.txt'), 'slow edit\n');
  for (const name of ['a.txt', 'small.txt', 'slow.txt']) settle(path.join(worktree, name));

  const { gitRoutes } = await import('../git.js');
  app = Fastify();
  await app.register(gitRoutes, { prefix: '/api/git' });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}, 60_000);

afterAll(async () => {
  await app?.close();
  for (const pid of slowPidList()) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('GET /git/diff', () => {
  it('answers a text diff with the version token of the change list', async () => {
    const changes = await (await fetch(`${baseUrl}/api/git/changes?${new URLSearchParams({ workingDir: worktree })}`)).json() as {
      uncommitted: { path: string; token: string }[];
    };
    const { status, body } = await getJson({ path: 'a.txt' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'text', token: changes.uncommitted.find((entry) => entry.path === 'a.txt')!.token });
    expect((body as { diff: string }).diff).toContain('+edited');
  });

  it('answers too_large by default and the text with force=1', async () => {
    const guarded = await getJson({ path: 'small.txt' });
    expect(guarded.status).toBe(200);
    expect(guarded.body).toMatchObject({ kind: 'too_large', limit: 1024 * 1024, canForce: true } satisfies Partial<GitFileDiffResponse>);
    const forced = await getJson({ path: 'small.txt', force: '1' });
    expect(forced.body).toMatchObject({ kind: 'text' });
    expect((forced.body as { diff: string }).diff).toContain('+grown ');
    const invalid = await getJson({ path: 'small.txt', force: 'yes' });
    expect(invalid).toMatchObject({ status: 400, body: { code: 'VALIDATION_ERROR' } });
  });

  it('stops the git work when the client closes the request before the answer', async () => {
    fs.writeFileSync(slowPids, '');
    const before = readRuntimeCounters();
    const request = http.get(url({ path: 'slow.txt' }));
    request.on('error', () => undefined);
    await vi.waitFor(() => expect(slowPidList().length).toBeGreaterThan(0), { timeout: 15_000 });
    request.destroy();
    await vi.waitFor(() => expect(slowPidList().filter(alive)).toEqual([]), { timeout: 15_000 });
    await vi.waitFor(() => expect(readRuntimeCounters().gitDiffComputations - before.gitDiffComputations).toBe(1));
    // The next request starts afresh instead of joining the stopped one.
    fs.writeFileSync(slowScript, ['#!/bin/sh', 'cat "$1"', ''].join('\n'), { mode: 0o755 });
    const { body } = await getJson({ path: 'slow.txt' });
    expect(body).toMatchObject({ kind: 'text' });
    expect((body as { diff: string }).diff).toContain('+slow edit');
  }, 60_000);
});
