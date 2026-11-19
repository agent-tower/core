/**
 * Differential test: today's `GET /git/changes` (copied in ./legacy-git-
 * changes.ts) and `WorktreeManager.getGitOperationStatus` (used by Git
 * operations) against the two routes as they now answer from the
 * git state service, on the same fixture repositories.
 *
 * Only the differences approved for step 2 are allowed, and each is applied
 * explicitly below:
 * - `untrackedCount` is the number of untracked files (today: collapsed folders);
 * - paths with special characters are returned unquoted;
 * - files above the size limit have no line counts.
 * Step 4 adds a version token to every entry; it is checked for presence and
 * left out of the comparison.
 *
 * Runs in both placements: with the default config the service runs in this
 * process; with `vitest.command-helper.config.ts` in the command helper.
 */
import { execFileSync } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { GitOperationStatus } from '@agent-tower/shared';
import { isCommandHelperRunning } from '../../../runtime/command-helper/client.js';
import { readRuntimeCounters } from '../../../runtime/runtime-metrics.js';
import { WorktreeManager } from '../../worktree.manager.js';
import { getGitStatePlacement, getWorkspaceGitState } from '../git-state-facade.js';
import { toGitOperationStatus } from '../git-state-views.js';
import { buildScenarios, isolateGitConfiguration, withoutTokens, type Scenario } from './git-fixtures.js';
import { legacyGitChanges } from './legacy-git-changes.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-git-state-parity-'));
isolateGitConfiguration(root);
const scenarios = buildScenarios(path.join(root, 'fixtures'));
const dbPath = path.join(root, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
process.env.AGENT_TOWER_DATA_DIR = path.join(root, 'data');

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

type Entry = { status: string; path: string; additions?: number; deletions?: number };

/** Undoes git's C-style path quoting (`"\344\270\255.txt"`). */
function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = body[++i]!;
    if (next in escapes) bytes.push(escapes[next]!);
    else if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(92, ...Buffer.from(next, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

function applyApprovedChangeDifferences(entries: Entry[], scenario: Scenario): Entry[] {
  return entries.map((entry) => {
    const normalized: Entry = { ...entry, path: unquoteGitPath(entry.path) };
    if (scenario.largePaths?.includes(normalized.path)) {
      delete normalized.additions;
      delete normalized.deletions;
    }
    return normalized;
  });
}

/** Untracked files, one by one, as the new `untrackedCount` counts them. */
function untrackedFileCount(worktreePath: string): number {
  try {
    const output = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return output.split('\0').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function expectedStatus(legacy: GitOperationStatus, scenario: Scenario): GitOperationStatus {
  return {
    ...legacy,
    conflictedFiles: legacy.conflictedFiles.map(unquoteGitPath),
    untrackedCount: untrackedFileCount(scenario.worktreePath),
  };
}

let prisma: PrismaClient;
let app: FastifyInstance;
const workspaceIds = new Map<string, string>();

beforeAll(async () => {
  fs.closeSync(fs.openSync(dbPath, 'a'));
  execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${path.join(serverRoot, 'prisma/schema.prisma')}`], {
    cwd: serverRoot,
    env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
    stdio: 'pipe',
  });
  prisma = (await import('../../../utils/index.js')).prisma;
  const { gitRoutes } = await import('../../../routes/git.js');
  const { workspaceRoutes } = await import('../../../routes/workspaces.js');
  app = Fastify();
  await app.register(gitRoutes, { prefix: '/api/git' });
  await app.register(workspaceRoutes, { prefix: '/api' });
  for (const scenario of scenarios) {
    const project = await prisma.project.create({ data: { name: scenario.name, repoPath: scenario.repoPath } });
    const task = await prisma.task.create({ data: { title: scenario.name, projectId: project.id, status: 'IN_PROGRESS' } });
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id, branchName: `sc/${scenario.name}`, baseBranch: scenario.baseBranch,
        worktreePath: scenario.worktreePath, workingDir: scenario.workingDir, status: 'ACTIVE',
      },
    });
    workspaceIds.set(scenario.name, workspace.id);
  }
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("git state parity with today's implementation", () => {
  it('computes git state in the active placement', async () => {
    const clean = scenarios.find((scenario) => scenario.name === 'clean')!;
    const before = readRuntimeCounters();
    await getWorkspaceGitState({ worktreePath: clean.worktreePath, repositoryPath: clean.repoPath, baseBranch: clean.baseBranch });
    const after = readRuntimeCounters();
    const processes = after.gitStateGitProcesses - before.gitStateGitProcesses;
    console.info(`[git state parity] placement=${getGitStatePlacement()} git processes for a first computation: ${processes}`);
    expect(processes).toBeGreaterThan(0);
    if (isCommandHelperRunning()) {
      expect(getGitStatePlacement()).toBe('helper');
      // Started by the helper's own service, not relayed as owned commands.
      expect(after.commandsViaHelper - before.commandsViaHelper).toBe(0);
      expect(after.commandsInProcess - before.commandsInProcess).toBe(0);
    } else {
      expect(getGitStatePlacement()).toBe('server');
      expect(after.commandsInProcess - before.commandsInProcess).toBe(processes);
    }
  });

  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))('GET /git/changes: %s', async (_name, scenario) => {
    const legacy = await legacyGitChanges(scenario.workingDir, scenario.baseBranch);
    const response = await app.inject({ method: 'GET', url: `/api/git/changes?workingDir=${encodeURIComponent(scenario.workingDir)}` });
    if (legacy === null) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'GIT_UNAVAILABLE', workingDir: scenario.workingDir });
      return;
    }
    expect(response.statusCode, response.body).toBe(200);
    const changes = response.json() as { uncommitted: (Entry & { token: string })[]; committed: (Entry & { token: string })[] };
    for (const entry of [...changes.uncommitted, ...changes.committed]) expect(entry.token).toMatch(/^[\w-]{22}$/);
    expect({ uncommitted: withoutTokens(changes.uncommitted), committed: withoutTokens(changes.committed) }).toEqual({
      uncommitted: applyApprovedChangeDifferences(legacy.uncommitted, scenario),
      committed: applyApprovedChangeDifferences(legacy.committed, scenario),
    });
  }, 60_000);

  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))('GET /workspaces/:id/git-status: %s', async (_name, scenario) => {
    const legacy = await new WorktreeManager(scenario.repoPath).getGitOperationStatus(scenario.worktreePath, scenario.baseBranch);
    const expected = expectedStatus(legacy, scenario);
    const workspaceId = workspaceIds.get(scenario.name)!;
    // For a conflict, today's route adds a token (observeLiveConflict, then
    // authorizeConflictResolutionContext for the owner). Both stay in the
    // server unchanged, so their outcome, a token or a refusal, is the same
    // for both implementations.
    let liveConflict: { ok: true } | { ok: false; code: string } | null = null;
    if (expected.conflictOp && expected.conflictedFiles.length) {
      const { authorizeConflictResolutionContext, observeLiveConflict } = await import('../../../services/conflict-resolution-context.js');
      liveConflict = await observeLiveConflict(prisma, workspaceId)
        .then((token) => authorizeConflictResolutionContext(token, 'owner', prisma))
        .then(
          () => ({ ok: true as const }),
          (error: { code: string }) => ({ ok: false as const, code: error.code }),
        );
    }
    const response = await app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/git-status` });
    if (liveConflict && !liveConflict.ok) {
      expect(response.json()).toMatchObject({ code: liveConflict.code });
      const state = await getWorkspaceGitState({ worktreePath: scenario.worktreePath, repositoryPath: scenario.repoPath, baseBranch: scenario.baseBranch });
      expect(toGitOperationStatus(state)).toEqual(expected);
      return;
    }
    expect(response.statusCode, response.body).toBe(200);
    const { resolutionContextToken, ...status } = response.json() as GitOperationStatus;
    expect(status).toEqual(expected);
    expect(Boolean(resolutionContextToken)).toBe(liveConflict?.ok === true);
  }, 60_000);

  it('keeps the constant status of a main-directory workspace and runs no git for it', async () => {
    const repo = scenarios.find((scenario) => scenario.name === 'main worktree of the repository')!.repoPath;
    const project = await prisma.project.create({ data: { name: 'main directory', repoPath: repo } });
    const task = await prisma.task.create({ data: { title: 'main directory', projectId: project.id } });
    const workspace = await prisma.workspace.create({
      data: { taskId: task.id, workspaceKind: 'MAIN_DIRECTORY', branchName: 'main-directory', worktreePath: repo, workingDir: repo, status: 'ACTIVE' },
    });
    const response = await app.inject({ method: 'GET', url: `/api/workspaces/${workspace.id}/git-status` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      operation: 'idle', conflictedFiles: [], conflictOp: null, ahead: 0, behind: 0,
      hasUncommittedChanges: false, uncommittedCount: 0, untrackedCount: 0,
    });
  });
});
