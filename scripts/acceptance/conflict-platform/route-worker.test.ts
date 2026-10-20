// Dedicated acceptance fixture, intentionally outside the default package test glob.
// Each phase runs in a fully new Node/Vitest process; all temporary secrets are removed by production-run.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ manager: undefined as any, settings: undefined as any,
  translation: undefined as any, delivery: undefined as any, spawn: vi.fn() }));
vi.mock('../../../packages/server/src/core/container.js', async original => ({
  ...await original<any>(), getSessionManager: () => state.manager,
  getTranslationSettingsService: () => state.settings, getTranslationService: () => state.translation,
  getMessageDeliveryService: () => state.delivery,
}));
vi.mock('../../../packages/server/src/executors/index.js', async original => ({
  ...await original<any>(),
  getProviderById: (id: string) => id === 'platform-fixture' ? { id, name: 'fixture', agentType: 'CURSOR_AGENT',
    runtimeType: 'CLI', executionPermission: 'FULL_ACCESS', config: {}, env: {}, isDefault: false } : null,
  createExecutorFromProvider: () => ({ spawn: state.spawn }),
}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const serverRoot = path.join(root, 'packages/server');
const serverRequire = createRequire(path.join(serverRoot, 'package.json'));
const fixture = process.env.TOWER_PLATFORM_FIXTURE!;
if (!fixture || !path.basename(path.dirname(fixture)).startsWith('tower-platform-')) throw new Error('ISOLATED_FIXTURE_REQUIRED');
const phase = process.env.TOWER_PLATFORM_PHASE!;
const kind = process.env.TOWER_PLATFORM_KIND!;
const scenario = process.env.TOWER_PLATFORM_SCENARIO!;
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(fixture, 'test.db').replaceAll('\\', '/')}`;
process.env.AGENT_TOWER_DATA_DIR = path.join(fixture, 'data');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(fixture, 'gitconfig');
process.env.GIT_TERMINAL_PROMPT = '0';
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
const savedPath = path.join(fixture, 'private-state.json');
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args],
  { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 20_000 });
const until = async (check: () => Promise<boolean> | boolean) => {
  const deadline = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('FIXTURE_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const decode = (token: string) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
let stage = 'setup';

it('executes one isolated actual-Route phase', async () => {
  let db: any; let app: any; let sink: ReturnType<typeof createServer> | undefined;
  const pipes: Pipe[] = [];
  let httpTranslations = 0;
  const report: Record<string, unknown> = { phase, kind, scenario, pid: process.pid, platform: process.platform,
    node: process.version, uv: process.versions.uv, status: 'FAIL', evidence: 'SOURCE_ROUTE_WITH_DETERMINISTIC_CLI' };
  class Pipe {
    pid = 4000 + pipes.length;
    exits: Array<(event: { exitCode: number }) => void> = [];
    listener?: (event: { type: 'stdout'; data: string }) => void;
    exited = false;
    onData() { return { dispose() {} }; }
    onExit = (fn: (event: { exitCode: number }) => void) => { this.exits.push(fn); return { dispose() {} }; };
    write() {} resize() {}
    kill = () => { if (this.exited) return; this.exited = true; for (const fn of this.exits) fn({ exitCode: 0 }); };
    finish() { if (this.exited) return; this.listener?.({ type: 'stdout', data: JSON.stringify({ type: 'result', subtype: 'success', result: 'Done' }) + '\n' }); this.kill(); }
    child(prompt: string) {
      return { pid: this.pid, pty: this, processGroupId: String(this.pid), birthMarker: `fixture:${this.pid}`,
        ownershipToken: `fixture:${this.pid}`, inputMode: 'raw', initialInput: prompt, verifyTreeCleanup: () => this.exited,
        duplex: { subscribe: (fn: Pipe['listener']) => { this.listener = fn; return () => {}; },
          write: async (text: string) => { fs.appendFileSync(path.join(fixture, 'receipts.jsonl'), JSON.stringify({ hash: hash(text) }) + '\n'); },
          end: async () => {}, close() {} } };
    }
  }
  try {
    if (phase === 'issue') {
      stage = 'isolated-schema';
      execFileSync(process.execPath, [serverRequire.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate',
        '--schema', path.join(serverRoot, 'prisma/schema.prisma')], { cwd: serverRoot, env: process.env, stdio: 'pipe', timeout: 30_000 });
    }
    if (phase === 'verify' && scenario !== 'restart') {
      // A is gone, and B has not imported or constructed any production service yet.
      stage = 'offline-mutation';
      const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
      if (scenario === 'unstaged') fs.appendFileSync(path.join(saved.targetPath, 'base.txt'), '\nunstaged change\n');
      else {
        const beforeBytes = semanticSnapshot(saved);
        const rounds = scenario === 'fast-rebuild' ? Number(process.env.TOWER_PLATFORM_ITERATIONS) : 1;
        for (let i = 0; i < rounds; i++) rebuild(saved);
        expect(semanticSnapshot(saved)).toEqual(beforeBytes);
        report.rebuilds = rounds; report.identicalSemanticBytes = true;
      }
      report.mutatedBeforeServiceImport = true;
    }
    stage = 'real-services';
    db = (await import('../../../packages/server/src/utils/index.js')).prisma;
    const { EventBus } = await import('../../../packages/server/src/core/event-bus.js');
    const { SessionManager } = await import('../../../packages/server/src/services/session-manager.js');
    state.manager = new SessionManager(new EventBus(), undefined, undefined,
      { prepare: async () => {}, authorize: () => 'FULL_ACCESS', authorizeMode: () => 'FULL_ACCESS' } as never);
    state.settings = new (await import('../../../packages/server/src/services/translation-settings.service.js')).TranslationSettingsService(db);
    state.translation = new (await import('../../../packages/server/src/services/translation.service.js')).TranslationService(db, state.settings, { limits: { tickMs: 10 } });
    state.delivery = new (await import('../../../packages/server/src/services/message-delivery.service.js')).MessageDeliveryService(db, state.settings, state.translation, state.manager, { tickMs: 10 });
    state.spawn.mockImplementation(async ({ prompt, deliveryReceipt }: any) => {
      expect(deliveryReceipt).toBe(true); const pipe = new Pipe(); pipes.push(pipe); return pipe.child(prompt);
    });
    sink = createServer((_request, response) => { httpTranslations++; response.writeHead(500); response.end(); });
    await new Promise<void>(resolve => sink!.listen(0, '127.0.0.1', resolve));
    const address = sink.address() as { port: number };
    const config = await state.settings.getPublic();
    await state.settings.save({ expectedRevision: config.revision, enabled: process.env.TOWER_PLATFORM_TRANSLATION !== 'off',
      apiBaseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', apiKey: { action: 'replace', value: '' },
      sendTargetLanguage: 'English', displayTargetLanguage: 'Chinese', promptTemplate: '{{target_language}}\n{{text}}', maxConcurrency: 2 });
    await state.translation.start(); await state.delivery.start();
    const Fastify = serverRequire('fastify'); app = Fastify();
    const { workspaceRoutes } = await import('../../../packages/server/src/routes/workspaces.js');
    const { sessionRoutes } = await import('../../../packages/server/src/routes/sessions.js');
    await app.register(workspaceRoutes, { prefix: '/api' }); await app.register(sessionRoutes, { prefix: '/api' });
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload });
    const refresh = (saved: any, token = saved.token) => post(`/api/workspaces/${saved.sourceId}/conflict-context`, { resolutionContextToken: token });
    const send = (id: string, body: any) => post(`/api/sessions/${id}/message`, body);
    const receiptCount = () => fs.existsSync(path.join(fixture, 'receipts.jsonl'))
      ? fs.readFileSync(path.join(fixture, 'receipts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const accepted = async (id: string, body: any) => {
      const result = await send(id, body);
      report.admissionStatus = result.statusCode;
      expect(result.statusCode).toBe(202);
      const operationId = result.json().operationId;
      stage = 'wait-for-cli-receipt';
      await until(async () => {
        const current = await db.messageDelivery.findUniqueOrThrow({ where: { id: operationId } });
        report.deliveryState = current.state; report.spawnCalls = state.spawn.mock.calls.length;
        return current.state === 'SENT';
      });
      const row = await db.messageDelivery.findUniqueOrThrow({ where: { id: operationId } });
      stage = 'check-frozen-row';
      expect(row.sessionId).toBe(id); expect(row.clientSubmissionId).toBe(body.clientSubmissionId);
      expect(row.requiresTranslation).toBe(false); expect(row.translationSourceId).toBeNull();
      expect(JSON.parse(row.attachmentIds)).toEqual([]);
      expect(row.acceptedText).not.toContain('untrusted client text');
      for (const pipe of pipes) pipe.finish();
      // This fixture acknowledges input but performs no Agent work. Explicitly stop it
      // through the real manager before the next intentional request (no DB status patch).
      stage = 'stop-deterministic-session';
      await state.manager.stop(id, { skipTeamRunReconcile: true });
      report.deterministicSessionExplicitlyStopped = true;
      await until(async () => {
        const session = await db.session.findUniqueOrThrow({ where: { id } });
        report.sessionState = session.status; return session.status !== 'RUNNING';
      });
      return row;
    };
    if (phase === 'issue') {
      stage = 'git-fixture';
      const saved: any = await createFixture(db, state.manager);
      const { WorktreeManager } = await import('../../../packages/server/src/git/worktree.manager.js');
      const gitModule = await import('../../../packages/server/src/git/git-cli.js');
      const originalGit = gitModule.execGit;
      const abort = vi.spyOn(gitModule, 'execGit').mockImplementation((cwd, args, ...rest) => args[0] === 'merge' && args[1] === '--abort'
        ? Promise.reject(new Error('fixture abort failure only')) : originalGit(cwd, args, ...rest));
      let advanced = false;
      const originalPreflight = WorktreeManager.prototype.getBranchStatus;
      const race = vi.spyOn(WorktreeManager.prototype, 'getBranchStatus').mockImplementation(async function (this: InstanceType<typeof WorktreeManager>, ...args) {
        const result = await originalPreflight.apply(this, args);
        if (kind === 'squash' && !advanced) { advanced = true; advanceTarget(saved); }
        return result;
      });
      stage = 'real-conflict-route';
      const conflict = await post(`/api/workspaces/${saved.sourceId}/${kind === 'rebase' ? 'rebase' : 'merge'}`, {});
      abort.mockRestore(); race.mockRestore();
      expect(conflict.statusCode).toBe(409);
      const details = conflict.json();
      report.conflictCode = typeof details.code === 'string' && /^[A-Z_0-9]{1,80}$/.test(details.code) ? details.code : 'UNKNOWN';
      expect(details.code).toBe('MERGE_CONFLICT'); expect(details.conflictedFiles).toEqual(['base.txt']);
      expect(details.conflictOp).toBe(kind === 'rebase' ? 'REBASE' : 'MERGE');
      expect(details.sourceWorkspaceId).toBe(saved.sourceId); expect(details.sourceWorktreePath).toBe(saved.sourcePath);
      expect(details.targetWorktreePath).toBe(saved.targetPath); expect(details.sourceBranch).toBe('feature/source');
      expect(details.targetBranch).toBe(kind === 'no_ff' ? 'target' : 'main');
      if (kind !== 'rebase') { expect(details.mergeAborted).toBe(false); expect(details.mergeStrategy).toBe(kind); }
      expect(typeof details.resolutionContextToken).toBe('string');
      saved.token = details.resolutionContextToken;
      const payload = decode(saved.token); expect(payload.recovery).toBeTruthy();
      expect(payload.recovery.expiresAt - payload.recovery.issuedAt).toBe(7 * 86400_000);
      saved.originalBody = { clientSubmissionId: randomUUID(), systemAction: 'resolve_conflicts', resolutionContextToken: saved.token,
        message: 'untrusted client text', attachmentIds: [] };
      stage = 'first-real-session-admission';
      const row = await accepted(saved.sourceSessionId, saved.originalBody);
      stage = 'check-first-receipt-count';
      saved.recordId = row.id; saved.frozenHash = hash(row.acceptedText); saved.originalReceipts = receiptCount();
      expect(saved.originalReceipts).toBe(1);
      expect(row.acceptedText).toContain(JSON.stringify(saved.targetPath));
      stage = 'first-read-only-snapshot';
      saved.scene = snapshot(saved); saved.issuePid = process.pid;
      fs.writeFileSync(savedPath, JSON.stringify(saved), { mode: 0o600 });
      report.firstAdmission = true; report.completeProof = true; report.receipts = receiptCount();
    } else {
      const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
      expect(saved.issuePid).not.toBe(process.pid);
      report.previousProcessExited = true;
      stage = 'accepted-original-body-first';
      const beforeReceipts = receiptCount();
      const duplicate = await send(saved.sourceSessionId, saved.originalBody);
      expect(duplicate.statusCode).toBe(202); expect(duplicate.json().operationId).toBe(saved.recordId);
      expect(hash((await db.messageDelivery.findUniqueOrThrow({ where: { id: saved.recordId } })).acceptedText)).toBe(saved.frozenHash);
      expect(receiptCount()).toBe(beforeReceipts);
      const newBody = { ...saved.originalBody, clientSubmissionId: randomUUID() };
      expect((await send(saved.sourceSessionId, newBody)).statusCode).toBe(409);
      if (scenario === 'restart') {
        stage = 'read-only-restart-refresh';
        const before = snapshot(saved); const rowCount = await db.messageDelivery.count();
        const gitModule = await import('../../../packages/server/src/git/git-cli.js');
        const observedGit = vi.spyOn(gitModule, 'execGit');
        const renewed = await refresh(saved); expect(renewed.statusCode).toBe(200);
        const token = renewed.json().resolutionContextToken;
        const original = decode(saved.token); const fresh = decode(token);
        for (const field of ['operationId', 'actor', 'context', 'recovery']) expect(fresh[field]).toEqual(original[field]);
        expect(fresh.expiresAt).toBeLessThanOrEqual(original.recovery.expiresAt);
        expect(snapshot(saved)).toEqual(before); expect(await db.messageDelivery.count()).toBe(rowCount);
        const clock = vi.spyOn(Date, 'now');
        try {
          clock.mockReturnValue(original.recovery.issuedAt + 25 * 3600_000);
          expect((await refresh(saved)).statusCode).toBe(200);
          clock.mockReturnValue(original.recovery.expiresAt - 1000);
          const near = await refresh(saved); expect(near.statusCode).toBe(200);
          expect(decode(near.json().resolutionContextToken).expiresAt).toBe(original.recovery.expiresAt);
          clock.mockReturnValue(original.recovery.expiresAt);
          expect((await refresh(saved)).statusCode).toBe(409);
          expect((await send(saved.sourceSessionId, { ...newBody, resolutionContextToken: token })).statusCode).toBe(409);
          expect((await send(saved.sourceSessionId, saved.originalBody)).statusCode).toBe(202);
        } finally { clock.mockRestore(); }
        expect(observedGit.mock.calls.every(([, args, options]) => ['rev-parse', 'ls-files', 'symbolic-ref'].includes(args[0])
          && options?.optionalLocks === false)).toBe(true);
        report.readOnlyGitCommands = observedGit.mock.calls.length;
        observedGit.mockRestore();
        stage = 'legal-source-target-sessions';
        const body = { ...newBody, resolutionContextToken: token };
        await accepted(saved.sourceSessionId, body);
        if (saved.targetSessionId) await accepted(saved.targetSessionId, { ...body, clientSubmissionId: randomUUID() });
        expect((await send(saved.unrelatedSessionId, { ...body, clientSubmissionId: randomUUID() })).statusCode).toBe(409);
        report.renewedReadOnly = true; report.fixedDeadline = true;
      } else {
        expect(snapshot(saved)).not.toEqual(saved.scene);
        stage = 'changed-scene-rejected';
        expect((await refresh(saved)).statusCode).toBe(409);
        expect((await send(saved.sourceSessionId, newBody)).statusCode).toBe(409);
        // Test-only key removal after all new-authority checks: the accepted lookup must not touch key or scene.
        fs.rmSync(process.env.AGENT_TOWER_DATA_DIR!, { recursive: true, force: true });
        const again = await send(saved.sourceSessionId, saved.originalBody);
        expect(again.statusCode).toBe(202); expect(again.json().operationId).toBe(saved.recordId);
        expect(hash((await db.messageDelivery.findUniqueOrThrow({ where: { id: saved.recordId } })).acceptedText)).toBe(saved.frozenHash);
        expect(await db.messageDelivery.count()).toBe(1); expect(receiptCount()).toBe(1);
        report.changedSceneRejected = true; report.acceptedSurvivesMissingKey = true;
      }
      report.receipts = receiptCount(); report.originalUuidFrozenBody = true;
    }
    stage = 'zero-translation';
    expect(httpTranslations).toBe(0); expect(await db.translationSource.count()).toBe(0); expect(await db.translationAttempt.count()).toBe(0);
    report.translationHttp = httpTranslations; report.translationRows = 0; report.status = 'PASS';
  } catch (error) {
    // Keep evidence free of tokens, raw response bodies, key material, paths and provider error text.
    report.failedStage = stage;
    report.assertionLine = (error as Error).stack?.split('\n').find(line => /route-worker.test.ts:\d+/.test(line))?.match(/route-worker.test.ts:\d+/)?.[0];
    const code = (error as { code?: string }).code;
    report.errorCode = typeof code === 'string' && /^[A-Z_0-9]{1,80}$/.test(code) ? code : 'ASSERTION_OR_FIXTURE_FAILURE';
    throw new Error(`Acceptance phase failed: ${stage}`);
  } finally {
    try {
      for (const pipe of pipes) pipe.finish();
      await state.delivery?.shutdown(); await state.translation?.shutdown(); await state.manager?.destroyAll();
      await app?.close(); await db?.$disconnect();
      if (sink) { sink.closeAllConnections(); await new Promise<void>(resolve => sink!.close(() => resolve())); }
    } finally {
      fs.writeFileSync(path.join(fixture, `${phase}-report.json`), JSON.stringify(report, null, 2)); vi.restoreAllMocks();
    }
  }
});

async function createFixture(db: any, manager: any) {
  const repo = path.join(fixture, 'repo'); const sourcePath = path.join(fixture, 'source');
  fs.mkdirSync(repo); const hooks = path.join(fixture, 'empty-hooks'); fs.mkdirSync(hooks);
  git(repo, 'init', '-b', 'main');
  for (const [name, value] of [['user.name', 'Acceptance'], ['user.email', 'fixture@example.test'], ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'], ['core.eol', 'lf'], ['core.hooksPath', hooks]]) git(repo, 'config', name, value);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  git(repo, 'worktree', 'add', '-b', 'feature/source', sourcePath, 'main');
  fs.writeFileSync(path.join(sourcePath, 'base.txt'), 'source\n'); git(sourcePath, 'add', '.'); git(sourcePath, 'commit', '-m', 'source');
  const targetPath = kind === 'rebase' ? sourcePath : kind === 'squash' ? repo : path.join(fixture, 'target');
  if (kind === 'no_ff') git(repo, 'worktree', 'add', '-b', 'target', targetPath, 'main');
  const project = await db.project.create({ data: { name: 'platform acceptance', repoPath: repo } });
  const task = await db.task.create({ data: { projectId: project.id, title: 'platform acceptance', status: 'IN_REVIEW' } });
  const target = kind === 'no_ff' ? await db.workspace.create({ data: { taskId: task.id, branchName: 'target', worktreePath: targetPath, workingDir: targetPath } }) : null;
  const source = await db.workspace.create({ data: { taskId: task.id, branchName: 'feature/source', worktreePath: sourcePath,
    workingDir: sourcePath, baseBranch: 'main', parentWorkspaceId: target?.id } });
  const receiver = await manager.create(source.id, 'CURSOR_AGENT', 'resolve', 'DEFAULT', 'platform-fixture');
  const targetReceiver = target ? await manager.create(target.id, 'CURSOR_AGENT', 'resolve', 'DEFAULT', 'platform-fixture') : null;
  // The real merge preflight blocks a pending target Session. End this idle fixture
  // through its normal lifecycle so the target is eligible, without changing Git.
  if (targetReceiver) await manager.stop(targetReceiver.id, { skipTeamRunReconcile: true });
  const unrelatedWorkspace = await db.workspace.create({ data: { taskId: task.id, branchName: 'unrelated', worktreePath: repo } });
  const unrelated = await manager.create(unrelatedWorkspace.id, 'CURSOR_AGENT', 'unrelated', 'DEFAULT', 'platform-fixture');
  const saved = { repo, sourcePath, targetPath, sourceId: source.id, targetId: target?.id,
    sourceSessionId: receiver.id, targetSessionId: targetReceiver?.id, unrelatedSessionId: unrelated.id };
  if (kind === 'rebase') advanceTarget({ ...saved, targetPath: repo });
  if (kind === 'no_ff') advanceTarget(saved);
  return saved;
}
function advanceTarget(saved: any) {
  fs.writeFileSync(path.join(saved.targetPath, 'base.txt'), 'target\n');
  git(saved.targetPath, 'add', '.'); git(saved.targetPath, 'commit', '-m', 'target');
}
function rebuild(saved: any) {
  if (kind === 'rebase') git(saved.targetPath, 'rebase', '--abort');
  else if (kind === 'no_ff') git(saved.targetPath, 'merge', '--abort');
  else git(saved.targetPath, 'reset', '--hard', 'HEAD');
  try { git(saved.targetPath, ...(kind === 'rebase' ? ['rebase', 'main'] : kind === 'no_ff'
    ? ['merge', '--no-ff', 'feature/source'] : ['merge', '--squash', '--no-commit', 'feature/source'])); }
  catch { /* expected real Git conflict; semanticSnapshot below must prove the same operation bytes */ }
}
const markerNames = ['index', 'MERGE_HEAD', 'ORIG_HEAD', 'SQUASH_MSG', 'AUTO_MERGE', 'rebase-merge', 'rebase-apply'];
function observedPaths(saved: any): Array<[string, string]> {
  const gitDir = git(saved.targetPath, 'rev-parse', '--absolute-git-dir').trim();
  const commonDir = path.resolve(saved.targetPath, git(saved.targetPath, 'rev-parse', '--git-common-dir').trim());
  const result: Array<[string, string]> = [['source-dir', saved.sourcePath], ['target-dir', saved.targetPath], ['git-dir', gitDir], ['common-dir', commonDir], ['workfile', path.join(saved.targetPath, 'base.txt')]];
  const visit = (name: string, file: string) => {
    result.push([name, file]);
    if (fs.existsSync(file) && fs.lstatSync(file).isDirectory()) for (const child of fs.readdirSync(file).sort()) visit(`${name}/${child}`, path.join(file, child));
  };
  for (const name of markerNames) visit(name, path.join(gitDir, name));
  return result;
}
function semanticSnapshot(saved: any) {
  // Rebase helper comments/message templates can contain timestamps. Compare the files used by production scene, not those irrelevant comments.
  const stable = new Set(['index', 'MERGE_HEAD', 'ORIG_HEAD', 'SQUASH_MSG', 'AUTO_MERGE', 'workfile',
    'rebase-merge/head-name', 'rebase-merge/onto', 'rebase-merge/orig-head', 'rebase-merge/stopped-sha', 'rebase-merge/msgnum',
    'rebase-merge/end', 'rebase-merge/done', 'rebase-merge/git-rebase-todo', 'rebase-apply/head-name', 'rebase-apply/onto', 'rebase-apply/orig-head', 'rebase-apply/next', 'rebase-apply/last']);
  return { head: git(saved.targetPath, 'rev-parse', 'HEAD'), refs: git(saved.repo, 'show-ref'),
    stages: git(saved.targetPath, 'ls-files', '--unmerged', '-z'),
    files: observedPaths(saved).filter(([name]) => stable.has(name)).map(([name, file]) => [name,
      fs.existsSync(file) && fs.lstatSync(file).isFile() ? hash(fs.readFileSync(file)) : null]) };
}
function snapshot(saved: any) {
  return { semantic: semanticSnapshot(saved), paths: observedPaths(saved).map(([name, file]) => {
    if (!fs.existsSync(file)) return [name, null];
    const stat = fs.lstatSync(file, { bigint: true });
    return [name, ['dev', 'ino', 'birthtimeNs', 'ctimeNs', 'mtimeNs', 'mode', 'size'].map(key => String((stat as any)[key])),
      stat.isFile() ? hash(fs.readFileSync(file)) : null];
  }) };
}
