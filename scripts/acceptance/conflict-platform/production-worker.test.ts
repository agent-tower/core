// Observes production admission. No test-only deadlines, cancellation gates or transaction options.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  getProviderById: (id: string) => id === 'admission-fixture' ? { id, name: 'fixture', agentType: 'CURSOR_AGENT',
    runtimeType: 'CLI', executionPermission: 'FULL_ACCESS', config: {}, env: {}, isDefault: false } : null,
  createExecutorFromProvider: () => ({ spawn: state.spawn }),
}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const serverRoot = path.join(root, 'packages/server');
const require = createRequire(path.join(serverRoot, 'package.json'));
const fixture = process.env.TOWER_ADMISSION_FIXTURE!;
if (!fixture || !path.basename(path.dirname(fixture)).startsWith('tower-admission-')) throw new Error('ISOLATED_FIXTURE_REQUIRED');
if (process.platform === 'win32') throw new Error('POSIX_PRODUCTION_PATH_ONLY');
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(fixture, 'test.db').replaceAll('\\', '/')}`;
process.env.AGENT_TOWER_DATA_DIR = path.join(fixture, 'data');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(fixture, 'gitconfig');
process.env.GIT_TERMINAL_PROMPT = '0';
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const until = async (check: () => Promise<boolean> | boolean) => {
  const end = performance.now() + 10_000;
  while (!await check()) { if (performance.now() >= end) throw new Error('FIXTURE_TIMEOUT'); await pause(5); }
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args],
  { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 });
type Observation = { scene: number; key: number; git: number; resolve: number; creates: number; tx: number;
  options: unknown[]; deadlines: number[]; codes: string[]; ordinaryMs?: number; clockOffset: number; role?: 'A' | 'B'; lookup?: boolean; prepareError?: string; recoveryReads?: number };
const context = new AsyncLocalStorage<Observation>();
const observation = (role?: Observation['role']): Observation => ({ scene: 0, key: 0, git: 0, resolve: 0, creates: 0, tx: 0, options: [], deadlines: [], codes: [], clockOffset: 0, role });
const barrier = () => { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; };


it('exercises production admission through real Routes, Git, Prisma and delivery', async () => {
  let db: any; let app: any; let stage = 'schema'; let scenario = ''; let activeFixture: any; let writes = 0;
  const results: any[] = []; const pipes: any[] = [];
  const report: any = { status: 'FAIL', results, nativeHelperStarts: 0, nativeHelperRPCs: 0 };
  let release: (() => void) | undefined;
  let race: { id: string; missing: number; precheck: ReturnType<typeof barrier>; a: ReturnType<typeof barrier>; b: ReturnType<typeof barrier>; commitLost?: boolean; recovery: ReturnType<typeof barrier>; recoveryRead?: boolean; recoveryStarted?: boolean; recheck: ReturnType<typeof barrier>; recheckRead?: boolean } | undefined;
  const concurrent: Promise<any>[] = [];
  try {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate',
      '--schema', path.join(serverRoot, 'prisma/schema.prisma')], { cwd: serverRoot, env: process.env, stdio: 'pipe', timeout: 30_000 });
    const utils = await import('../../../packages/server/src/utils/index.js');
    db = utils.prisma; await utils.initializeDatabaseRuntime();
    const nativeTransaction = db.$transaction.bind(db);
    vi.spyOn(db, '$transaction').mockImplementation(async (fn: any, options: any) => {
      const o = context.getStore(); if (o) { o.tx++; o.options.push(options); }
      const result = await nativeTransaction(fn, options); // Production supplies all options and guards.
      if (scenario === 'concurrent-lost-commit' && o?.role === 'A') {
        race!.commitLost = true; throw new Error('Injected lost commit response');
      }
      return result;
    });
    db.$use(async (params: any, next: any) => {
      const o = context.getStore();
      if (race?.commitLost && o?.role === 'A' && params.model === 'MessageDelivery' && params.action === 'findUnique' && params.args.where.clientSubmissionId === race.id) {
        throw new Error('Injected unavailable recovery read after lost commit response');
      }
      const recovery = race && o?.role === 'B' && o.lookup && o.prepareError
        && params.model === 'MessageDelivery' && params.action === 'findUnique' && params.args.where.clientSubmissionId === race.id;
      if (recovery) {
        o.recoveryReads = (o.recoveryReads ?? 0) + 1;
        if (scenario === 'concurrent-stale-read-failure' && o.recoveryReads === 2) throw new Error('Injected unavailable recheck after stale null');
        if (scenario === 'concurrent-reading-commit' && o.recoveryReads === 1) {
          race!.recoveryStarted = true;
          await race!.recovery.promise; // Lookup entered before A commits; real SQLite query follows the barrier.
        }
      }
      if (o && params.model === 'MessageDelivery' && params.action === 'create') {
        o.creates++;
        if (scenario === 'tx-timeout') await pause(4200); // In-flight DB call, after the production front door.
      }
      let result: any;
      try { result = await next(params); } catch (error) { if (o) o.codes.push((error as any).code); throw error; }
      if (recovery && scenario.startsWith('concurrent-stale-') && o!.recoveryReads === 1) {
        expect(result).toBeNull(); race!.recoveryRead = true;
        await race!.recovery.promise; // Keep the real SQLite null until A has settled and retired.
      }
      if (recovery && scenario === 'concurrent-stale-churn' && o!.recoveryReads === 2) {
        expect(result).toBeNull(); race!.recheckRead = true;
        await race!.recheck.promise; // Another real admission joins/retires during the last allowed read.
      }
      if (race && o?.role && params.model === 'MessageDelivery' && params.action === 'findUnique' && params.args.where.clientSubmissionId === race.id && !o.lookup) {
        o.lookup = true; expect(result).toBeNull(); race.missing++;
        if (race.missing === 2) race.precheck.open();
        await race.precheck.promise; // Both real initial reads returned no durable row.
      }
      if (['concurrent-unknown', 'concurrent-stale-unknown'].includes(scenario) && o?.role === 'A' && params.model === 'MessageDelivery' && params.action === 'create') {
        throw new Error('Injected unknown write result'); // Real create ran; real transaction rolls back.
      }
      if (o && params.model === 'MessageDelivery' && params.action === 'aggregate') {
        if (scenario === 'key-change') {
          const key = path.join(process.env.AGENT_TOWER_DATA_DIR!, 'conflict-recovery-key');
          fs.writeFileSync(`${key}.replacement`, fs.readFileSync(key), { mode: 0o600, flag: 'wx' }); fs.renameSync(`${key}.replacement`, key);
        } else if (scenario === 'scene-change') fs.appendFileSync(path.join(activeFixture.sourcePath, 'base.txt'), '\nchanged\n');
        else if (['expiry-24h', 'expiry-7d'].includes(scenario)) {
          const payload = JSON.parse(Buffer.from(activeFixture.token.split('.')[0], 'base64url').toString('utf8'));
          o.clockOffset = (scenario === 'expiry-24h' ? payload.expiresAt : payload.recovery.expiresAt) - realNow();
        } else if (scenario === 'no-retry') throw Object.assign(new Error('Injected serialization conflict'), { code: 'P2034' });
      }
      return result;
    });
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (context.getStore()?.clockOffset ?? 0));
    const gitModule = await import('../../../packages/server/src/git/git-cli.js'); const realGit = gitModule.execGit;
    vi.spyOn(gitModule, 'execGit').mockImplementation(async (cwd, args, options) => {
      const o = context.getStore();
      if (o) {
        o.git++; expect(options?.signal).toBeInstanceOf(AbortSignal); expect(options!.timeout).toBeGreaterThan(0);
        expect(options!.timeout).toBeLessThanOrEqual(o.resolve === 1 ? 6000 : 2500); o.deadlines.push(options!.timeout!);
        if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
          const n = ++o.scene;
          if (scenario === 'cold' && n === 1) await pause(600);
          if (scenario === 'prepare-slow' && n === 1) await pause(6100);
          if (scenario === 'final-slow' && n === 3) await pause(2600);
        }
      }
      return realGit(cwd, args, options); // Original Git always runs, including with an aborted production signal.
    });
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: any[]) => {
      const o = context.getStore(); if (o && String(args[0]) === path.join(process.env.AGENT_TOWER_DATA_DIR!, 'conflict-recovery-key')) o.key++;
      return (realOpen as any)(...args);
    });
    const conflict = await import('../../../packages/server/src/services/conflict-resolution-context.js'); const realResolve = conflict.resolveConflictInstructions;
    vi.spyOn(conflict, 'resolveConflictInstructions').mockImplementation(async (...args) => {
      const o = context.getStore(); if (o) o.resolve++;
      if (race && o?.resolve === 1) await (o.role === 'A' ? race.a : race.b).promise;
      let result: string;
      try { result = await realResolve(...args); }
      catch (error) { if (o) o.prepareError = (error as any).code; throw error; }
      if (o && o.resolve === 2 && scenario === 'expiry-create') {
        const payload = JSON.parse(Buffer.from(activeFixture.token.split('.')[0], 'base64url').toString('utf8'));
        o.clockOffset = payload.expiresAt - realNow();
      }
      return result;
    });
    app = require('fastify')();
    app.addHook('onRequest', async (request: any) => { if (request.headers['x-test-agent']) request.agentTowerAuthKind = 'agent'; });
    await app.register((await import('../../../packages/server/src/routes/workspaces.js')).workspaceRoutes, { prefix: '/api' });
    await app.register((await import('../../../packages/server/src/routes/sessions.js')).sessionRoutes, { prefix: '/api' });
    const cases = ['success', 'cold', 'prepare-slow', 'final-slow', 'key-change', 'scene-change', 'expiry-24h', 'expiry-7d', 'expiry-create', 'queue-timeout', 'shutdown-queued', 'shutdown-prepare', 'ticket-pressure', 'tx-timeout', 'no-retry', 'concurrent-scene', 'concurrent-24h', 'concurrent-key', 'concurrent-pending', 'concurrent-unknown', 'concurrent-lost-commit', 'concurrent-stale-read', 'concurrent-reading-commit', 'concurrent-stale-read-failure', 'concurrent-stale-different-intent', 'concurrent-stale-purpose', 'concurrent-stale-unknown', 'concurrent-different-intent', 'concurrent-stale-refused', 'concurrent-stale-churn'];
    const selected = process.env.TOWER_ADMISSION_CASE ?? 'all';
    const recoveryCases = cases.slice(-9);
    if (!['all', 'uuid', 'recovery'].includes(selected) && !cases.includes(selected)) throw new Error('UNKNOWN_CASE');
    for (scenario of cases.filter(item => selected === 'all' ? !item.startsWith('concurrent-') : selected === 'uuid' ? item.startsWith('concurrent-') && !recoveryCases.includes(item) : selected === 'recovery' ? recoveryCases.includes(item) : item === selected)) {
      stage = `${scenario}:setup`;
      const { EventBus } = await import('../../../packages/server/src/core/event-bus.js');
      const { SessionManager } = await import('../../../packages/server/src/services/session-manager.js');
      state.manager = new SessionManager(new EventBus(), undefined, undefined,
        { prepare: async () => {}, authorize: () => 'FULL_ACCESS', authorizeMode: () => 'FULL_ACCESS' } as never);
      state.settings = new (await import('../../../packages/server/src/services/translation-settings.service.js')).TranslationSettingsService(db);
      state.translation = new (await import('../../../packages/server/src/services/translation.service.js')).TranslationService(db, state.settings);
      state.delivery = new (await import('../../../packages/server/src/services/message-delivery.service.js')).MessageDeliveryService(db, state.settings, state.translation, state.manager, { tickMs: 10 });
      await state.settings.getPublic(); await state.translation.start(); await state.delivery.start(); await state.manager.startConversationQueue();
      const realWake = state.delivery.wake.bind(state.delivery); state.delivery.wake = () => context.exit(realWake);
      state.spawn.mockImplementation(async ({ prompt, deliveryReceipt }: any) => {
        expect(deliveryReceipt).toBe(true); let stopped = false; const exits: any[] = []; const pid = 900_000 + pipes.length;
        const pipe: any = { pid, onData: () => ({ dispose() {} }), onExit: (fn: any) => { exits.push(fn); return { dispose() {} }; },
          write() {}, resize() {}, kill: () => { if (!stopped) { stopped = true; for (const fn of exits) fn({ exitCode: 0 }); } } };
        pipes.push(pipe);
        return { pid, pty: pipe, processGroupId: String(pid), birthMarker: `fixture:${pid}`, ownershipToken: `fixture:${pid}`,
          inputMode: 'raw', initialInput: prompt, verifyTreeCleanup: () => stopped,
          duplex: { subscribe: () => () => {}, write: async () => { writes++; }, end: async () => {}, close() {} } };
      });
      activeFixture = await seed(db, state.manager, app, `${results.length}`);
      const body = { clientSubmissionId: randomUUID(), systemAction: 'resolve_conflicts', resolutionContextToken: activeFixture.token, message: 'untrusted fixture text' };
      const o = observation();
      const post = (id: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/sessions/${id}/message`, payload });
      if (scenario.startsWith('concurrent-')) {
        stage = `${scenario}:race`;
        const a = observation('A'); const b = observation('B'); const writesBefore = writes;
        race = { id: body.clientSubmissionId, missing: 0, precheck: barrier(), a: barrier(), b: barrier(), recovery: barrier(), recheck: barrier() };
        const first = context.run(a, async () => await post(activeFixture.sessionId, body));
        const second = context.run(b, async () => await post(activeFixture.sessionId, ['concurrent-stale-different-intent', 'concurrent-different-intent'].includes(scenario) ? { ...body, message: 'concurrently different intent' } : body));
        concurrent.push(first, second);
        await until(() => race!.missing === 2 && a.resolve === 1 && b.resolve === 1);
        const key = path.join(process.env.AGENT_TOWER_DATA_DIR!, 'conflict-recovery-key');
        const payload = JSON.parse(Buffer.from(body.resolutionContextToken.split('.')[0], 'base64url').toString('utf8'));
        let movedKey = false; let changedPurpose = false; let firstResponse: any; let secondResponse: any;
        try {
          delete report.recoveryOrdering;
          if (scenario.startsWith('concurrent-stale-') || scenario === 'concurrent-reading-commit') {
            b.clockOffset = payload.expiresAt - realNow(); race.b.open();
            await until(() => race!.recoveryRead === true || race!.recoveryStarted === true);
            if (['concurrent-stale-refused', 'concurrent-stale-churn'].includes(scenario)) a.clockOffset = payload.expiresAt - realNow();
            race.a.open(); firstResponse = await first;
            expect(firstResponse.statusCode, firstResponse.body).toBe(['concurrent-stale-unknown', 'concurrent-stale-refused', 'concurrent-stale-churn'].includes(scenario) ? 409 : 202);
            report.recoveryOrdering = { readSawNull: race.recoveryRead === true, lookupStarted: race.recoveryStarted === true,
              firstHttp: firstResponse.statusCode, activeAfterA: state.delivery.conflictSubmissions.get(body.clientSubmissionId)?.active.size,
              revisionAfterA: state.delivery.conflictSubmissions.get(body.clientSubmissionId)?.revision,
              uncertainAfterA: state.delivery.conflictSubmissions.get(body.clientSubmissionId)?.uncertain,
              rowsBeforeBResume: await db.messageDelivery.count({ where: { clientSubmissionId: body.clientSubmissionId } }) };
            if (scenario === 'concurrent-stale-purpose') {
              await until(async () => (await db.messageDelivery.findUniqueOrThrow({ where: { clientSubmissionId: body.clientSubmissionId } })).state === 'SENT');
              await db.session.update({ where: { id: activeFixture.sessionId }, data: { purpose: 'COMMIT_MSG' } }); changedPurpose = true;
            }
            race.recovery.open();
            if (scenario === 'concurrent-stale-churn') {
              await until(() => race!.recheckRead === true);
              const third = await context.run({ ...observation(), clockOffset: payload.expiresAt - realNow() }, async () => await post(activeFixture.sessionId, body));
              expect(third.statusCode).toBe(409); expect(third.json().code).toBe('CONFLICT_ADMISSION_UNCERTAIN'); expect(third.json()).not.toHaveProperty('accepted');
              report.recoveryOrdering.thirdHttp = third.statusCode;
              race.recheck.open();
            }
            secondResponse = await second;
            report.recoveryOrdering.secondHttp = secondResponse.statusCode;
            report.recoveryOrdering.secondCode = secondResponse.json().code;
            report.recoveryOrdering.recoveryReads = b.recoveryReads;
            report.recoveryOrdering.groupsAfterSettled = state.delivery.conflictSubmissions.size;
            if (changedPurpose) { await db.session.update({ where: { id: activeFixture.sessionId }, data: { purpose: 'CHAT' } }); changedPurpose = false; }
          } else if (scenario === 'concurrent-pending') {
            b.clockOffset = payload.expiresAt - realNow(); race.b.open();
            secondResponse = await second; // A is still in PREPARE, with no row yet.
            expect(await db.messageDelivery.count({ where: { clientSubmissionId: body.clientSubmissionId } })).toBe(0);
            expect(secondResponse.json()).toMatchObject({ code: 'CONFLICT_ADMISSION_UNCERTAIN' });
            expect(secondResponse.json()).not.toHaveProperty('accepted');
            race.a.open(); firstResponse = await first;
          } else {
            race.a.open(); firstResponse = await first;
            report.lastObservation = { scenario, firstHttp: firstResponse.statusCode, firstCode: firstResponse.json().code, a, b };
            expect(firstResponse.statusCode, firstResponse.body).toBe(['concurrent-unknown', 'concurrent-stale-unknown'].includes(scenario) ? 409 : scenario === 'concurrent-lost-commit' ? 500 : 202);
            if (scenario === 'concurrent-scene') fs.appendFileSync(path.join(activeFixture.sourcePath, 'base.txt'), '\nchanged after A committed\n');
            else if (scenario === 'concurrent-key') { fs.renameSync(key, `${key}.saved`); movedKey = true; }
            else b.clockOffset = payload.expiresAt - realNow();
            race.b.open(); secondResponse = await second;
          }
          report.lastObservation = { scenario, firstHttp: firstResponse.statusCode, secondHttp: secondResponse.statusCode,
            secondBody: { code: secondResponse.json().code, accepted: secondResponse.json().accepted }, acceptedFalse: secondResponse.json().accepted === false, missingPrechecks: race.missing,
            prepareError: b.prepareError, rows: await db.messageDelivery.count({ where: { clientSubmissionId: body.clientSubmissionId } }) };
          expect(b.prepareError).toBe(scenario === 'concurrent-key' ? 'CONFLICT_RECOVERY_KEY_UNAVAILABLE' : 'CONFLICT_CONTEXT_INVALID');
          if (['concurrent-unknown', 'concurrent-stale-unknown'].includes(scenario)) {
            expect(firstResponse.json()).not.toHaveProperty('accepted');
            expect(secondResponse.json().code).toBe('CONFLICT_ADMISSION_UNCERTAIN');
            expect(await db.messageDelivery.count({ where: { clientSubmissionId: body.clientSubmissionId } })).toBe(0);
          }
          race = undefined; // Every original callback has settled; later retries use the actual SQLite result.
          if (['concurrent-unknown', 'concurrent-stale-unknown'].includes(scenario)) {
            const refusedOriginal = await context.run({ ...observation(), clockOffset: payload.expiresAt - realNow() }, async () =>
              await post(activeFixture.sessionId, body));
            expect(refusedOriginal.statusCode).toBe(409); expect(refusedOriginal.json()).toMatchObject({ code: 'CONFLICT_CONTEXT_INVALID', accepted: false });
            report.lastObservation.settledOriginalRefusal = { http: refusedOriginal.statusCode, accepted: refusedOriginal.json().accepted };
          }
          b.clockOffset = 0;
          if (movedKey) { fs.renameSync(`${key}.saved`, key); movedKey = false; }
          const again = await post(activeFixture.sessionId, body);
          expect(again.statusCode, again.body).toBe(202);
          const operationId = again.json().operationId;
          if (firstResponse.statusCode === 202) expect(firstResponse.json().operationId).toBe(operationId);
          if (secondResponse.statusCode === 202) expect(secondResponse.json().operationId).toBe(operationId);
          await until(async () => (await db.messageDelivery.findUniqueOrThrow({ where: { id: operationId } })).state === 'SENT');
          const rows = await db.messageDelivery.count({ where: { clientSubmissionId: body.clientSubmissionId } });
          const receipts = await db.deliveryReceipt.count({ where: { deliveryId: operationId, phase: 'SUBMITTED' } });
          report.lastObservation = { ...report.lastObservation, retryHttp: again.statusCode, operationId, sameOperation: firstResponse.statusCode === 202 ? firstResponse.json().operationId === operationId : secondResponse.statusCode === 202 ? secondResponse.json().operationId === operationId : null,
            rows, submittedReceipts: receipts, writes: writes - writesBefore };
          expect([rows, receipts, writes - writesBefore]).toEqual([1, 1, 1]);
          expect(secondResponse.statusCode, secondResponse.body).toBe(scenario === 'concurrent-stale-purpose' ? 404
            : scenario === 'concurrent-stale-read-failure' ? 500
            : ['concurrent-pending', 'concurrent-unknown', 'concurrent-stale-unknown', 'concurrent-stale-different-intent', 'concurrent-different-intent', 'concurrent-stale-refused', 'concurrent-stale-churn'].includes(scenario) ? 409 : 202);
          if (['concurrent-stale-different-intent', 'concurrent-different-intent'].includes(scenario)) expect(secondResponse.json().code).toBe('DELIVERY_CONFLICT');
          if (scenario === 'concurrent-stale-purpose') expect(secondResponse.json().code).toBe('NOT_FOUND');
          if (scenario.startsWith('concurrent-stale-')) expect(b.recoveryReads).toBe(scenario === 'concurrent-stale-purpose' ? 1 : 2);
          if (scenario === 'concurrent-reading-commit') expect(b.recoveryReads).toBe(1);
          if (scenario === 'concurrent-stale-refused') expect(secondResponse.json()).toMatchObject({ code: 'CONFLICT_CONTEXT_INVALID', accepted: false });
          else expect(secondResponse.json()).not.toHaveProperty('accepted');
          if (scenario === 'concurrent-stale-churn') expect(secondResponse.json().code).toBe('CONFLICT_ADMISSION_UNCERTAIN');
          if (['concurrent-stale-refused', 'concurrent-stale-churn'].includes(scenario)) expect(firstResponse.json().code).toBe('CONFLICT_ADMISSION_UNCERTAIN');
          else if (firstResponse.statusCode !== 202) expect(firstResponse.json()).not.toHaveProperty('accepted');
          // A genuinely new UUID has no accepted peer: expiry must still be a safe rejection.
          const refused = await context.run({ ...observation(), clockOffset: payload.expiresAt - realNow() }, async () =>
            await post(activeFixture.sessionId, { ...body, clientSubmissionId: randomUUID() }));
          expect(refused.statusCode).toBe(409); expect(refused.json()).toMatchObject({ code: 'CONFLICT_CONTEXT_INVALID', accepted: false });
          for (const [sessionId, patch, headers] of [
            [activeFixture.sessionId, { message: 'different intent' }, {}], [activeFixture.otherId, {}, {}],
            [activeFixture.sessionId, {}, { origin: 'https://foreign.example' }], [activeFixture.sessionId, {}, { 'x-test-agent': 'true' }],
          ] as const) {
            const denied = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/message`, payload: { ...body, ...patch }, headers });
            expect(denied.statusCode).toBe(Object.keys(headers).length ? 403 : 409);
            expect(denied.json()).not.toHaveProperty('operationId');
          }
          expect(await db.messageDelivery.count({ where: { clientSubmissionId: body.clientSubmissionId } })).toBe(1);
          expect(await db.deliveryReceipt.count({ where: { deliveryId: operationId, phase: 'SUBMITTED' } })).toBe(1);
          expect(await db.translationSource.count()).toBe(0); expect(await db.translationAttempt.count()).toBe(0);
          const resources = { groups: state.delivery.conflictSubmissions.size, admissions: state.delivery.admissions.size,
            preparationOwners: state.delivery.preparationSlots.active, preparationWaiters: state.delivery.preparationSlots.queue.length,
            finalTickets: state.delivery.finalTicket.active, finalWaiters: state.delivery.finalTicket.queue.length };
          expect(Object.values(resources)).toEqual([0, 0, 0, 0, 0, 0]);
          expect([a.scene, a.key, a.git, a.resolve, a.creates, a.tx]).toEqual(['concurrent-stale-refused', 'concurrent-stale-churn'].includes(scenario) ? [0, 0, 0, 1, 0, 0] : [4, 4, 24, 2, 1, 1]);
          for (const options of a.options as any[]) { expect(options.maxWait).toBeLessThanOrEqual(1000); expect(options.timeout).toBeLessThanOrEqual(4000); }
          results.push({ ...report.lastObservation, resources, recoveryOrdering: report.recoveryOrdering, operationId, rows, submittedReceipts: receipts, writes: writes - writesBefore,
            safeRefusal: { http: refused.statusCode, accepted: refused.json().accepted }, a, b });
        } finally {
          race?.precheck.open(); race?.a.open(); race?.b.open(); race?.recovery.open(); race?.recheck.open();
          await Promise.allSettled(concurrent.splice(0)); race = undefined;
          if (movedKey) fs.renameSync(`${key}.saved`, key);
          if (changedPurpose) await db.session.update({ where: { id: activeFixture.sessionId }, data: { purpose: 'CHAT' } });
        }
        for (const pipe of pipes) pipe.kill(); state.manager.stopConversationQueue();
        await state.delivery.shutdown(); await state.translation.shutdown(); await state.manager.destroyAll();
        state.delivery = undefined; state.translation = undefined; state.manager = undefined;
        continue;
      }
      if (['queue-timeout', 'shutdown-queued', 'ticket-pressure'].includes(scenario)) {
        const hold = new Promise<void>(resolve => { release = resolve; });
        state.delivery.mutationTail = state.delivery.mutationTail.then(() => hold); // Finite same-tail contention, no fake DB transaction.
      }
      stage = `${scenario}:request`; const start = performance.now();
      const pending = context.run(o, async () => await post(activeFixture.sessionId, body));
      let ordinary: Promise<any> | undefined; let shutdown: Promise<void> | undefined;
      if (['cold', 'prepare-slow'].includes(scenario)) {
        await pause(50); const ordinaryStart = performance.now();
        ordinary = Promise.resolve(post(activeFixture.otherId, { clientSubmissionId: randomUUID(), message: 'ordinary fixture input' })).then(response => {
          o.ordinaryMs = Math.round(performance.now() - ordinaryStart); expect(response.statusCode).toBe(202); return response;
        });
      }
      let pressure: any;
      if (['queue-timeout', 'shutdown-queued', 'ticket-pressure'].includes(scenario)) {
        await until(() => (state.delivery.finalTicket as any).active === 1 && o.resolve === 1);
        if (scenario === 'shutdown-queued') shutdown = state.delivery.shutdown();
        else if (scenario === 'ticket-pressure') {
          const others = Array.from({ length: 12 }, () => Promise.resolve(post(activeFixture.sessionId, { ...body, clientSubmissionId: randomUUID() })));
          await until(() => state.delivery.finalTicket.queue.length === 1);
          await pause(2100); // Expire the later request's own ticket deadline as well.
          expect(state.delivery.finalTicket.active).toBe(1); // Expired queued closure still owns its ticket.
          expect(state.delivery.preparationSlots.active).toBeLessThanOrEqual(2);
          release!(); release = undefined;
          pressure = (await Promise.all(others)).map(response => response.statusCode);
          report.pressureObservations = pressure;
          expect(pressure.every((status: number) => [408, 429].includes(status))).toBe(true);
        } else await pause(2100);
        release?.(); release = undefined;
      }
      if (scenario === 'shutdown-prepare') {
        await until(() => o.scene > 0); shutdown = state.delivery.shutdown();
      }
      const response = await pending; const responseMs = Math.round(performance.now() - start); await ordinary; await shutdown; await state.delivery.mutationTail;
      o.clockOffset = 0;
      const rows = await db.messageDelivery.findMany({ where: { clientSubmissionId: body.clientSubmissionId } });
      report.lastObservation = { scenario, http: response.statusCode, rows: rows.length, ...o };
      const success = ['success', 'cold'].includes(scenario);
      expect(rows.length).toBe(success ? 1 : 0);
      expect(response.statusCode).toBe(success ? 202 : scenario.startsWith('shutdown') ? 409 : ['key-change', 'scene-change', 'expiry-24h', 'expiry-7d', 'expiry-create'].includes(scenario) ? 409 : scenario === 'no-retry' ? 500 : 408);
      if (success) {
        await until(async () => (await db.messageDelivery.findUnique({ where: { id: rows[0].id } })).state === 'SENT');
        expect([o.scene, o.key, o.git, o.resolve, o.creates, o.tx]).toEqual([4, 4, 24, 2, 1, 1]);
        const before = [o.scene, o.key, o.git];
        const key = path.join(process.env.AGENT_TOWER_DATA_DIR!, 'conflict-recovery-key'); fs.renameSync(key, `${key}.saved`);
        try {
          const again = await context.run(o, async () => await post(activeFixture.sessionId, { ...body, resolutionContextToken: `${body.resolutionContextToken.split('.')[0]}.old-process-signature` }));
          expect(again.statusCode).toBe(202); expect(again.json().operationId).toBe(rows[0].id); expect([o.scene, o.key, o.git]).toEqual(before);
        } finally { fs.renameSync(`${key}.saved`, key); }
        expect(rows[0].acceptedText).not.toContain(body.message); expect(rows[0].requiresTranslation).toBe(false);
      } else if (scenario !== 'tx-timeout') expect(o.creates).toBe(0);
      if (scenario === 'no-retry') expect(o.tx).toBe(1);
      if (scenario === 'tx-timeout') expect(o.codes).toContain('P2028');
      for (const options of o.options as any[]) { expect(options.maxWait).toBeLessThanOrEqual(1000); expect(options.timeout).toBeLessThanOrEqual(4000); }
      const receipts = await db.deliveryReceipt.count({ where: { deliveryId: { in: rows.map((row: any) => row.id) }, phase: 'SUBMITTED' } });
      expect(receipts).toBe(success ? 1 : 0); expect(await db.translationSource.count()).toBe(0); expect(await db.translationAttempt.count()).toBe(0);
      results.push({ scenario, responseMs, http: response.statusCode, ms: Math.round(performance.now() - start), rows: rows.length, submittedReceipts: receipts,
        scene: o.scene, key: o.key, git: o.git, resolves: o.resolve, creates: o.creates, transactions: o.tx, options: o.options,
        minimumGitTimeout: Math.min(...o.deadlines), ordinaryMs: o.ordinaryMs, prismaCodes: o.codes, pressure });
      for (const pipe of pipes) pipe.kill(); state.manager.stopConversationQueue();
      await state.delivery.shutdown(); await state.translation.shutdown(); await state.manager.destroyAll();
      state.delivery = undefined; state.translation = undefined; state.manager = undefined;
    }
    delete report.lastObservation; report.status = 'PASS_PRODUCTION_PATH';
  } catch (error) { report.stage = stage; report.assertion = (error as Error).message.slice(0, 200); throw error; }
  finally {
    release?.(); race?.precheck.open(); race?.a.open(); race?.b.open(); race?.recovery.open(); race?.recheck.open(); await Promise.allSettled(concurrent); for (const pipe of pipes) pipe.kill(); state.manager?.stopConversationQueue();
    await state.delivery?.shutdown(); await state.translation?.shutdown(); await state.manager?.destroyAll();
    await app?.close(); await db?.$disconnect(); vi.restoreAllMocks();
    fs.writeFileSync(path.join(fixture, 'admission-report.json'), JSON.stringify(report, null, 2));
  }
}, 150_000);

async function seed(db: any, manager: any, app: any, suffix: string) {
  const repo = path.join(fixture, `repo-${suffix}`); const sourcePath = path.join(fixture, `source-${suffix}`);
  fs.mkdirSync(repo); git(repo, 'init', '-b', 'main');
  const hooks = path.join(fixture, `hooks-${suffix}`); fs.mkdirSync(hooks);
  for (const [name, value] of [['user.name', 'Acceptance'], ['user.email', 'fixture@example.test'], ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'], ['core.hooksPath', hooks]]) git(repo, 'config', name, value);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  git(repo, 'worktree', 'add', '-b', 'feature/source', sourcePath, 'main');
  fs.writeFileSync(path.join(sourcePath, 'base.txt'), 'source\n'); git(sourcePath, 'add', '.'); git(sourcePath, 'commit', '-m', 'source');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'target\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'target');
  const project = await db.project.create({ data: { name: 'admission fixture', repoPath: repo } });
  const task = await db.task.create({ data: { projectId: project.id, title: 'admission fixture', status: 'IN_REVIEW' } });
  const workspace = await db.workspace.create({ data: { taskId: task.id, branchName: 'feature/source', worktreePath: sourcePath, workingDir: sourcePath, baseBranch: 'main' } });
  const otherWorkspace = await db.workspace.create({ data: { taskId: task.id, branchName: 'main', worktreePath: repo, workingDir: repo } });
  const session = await manager.create(workspace.id, 'CURSOR_AGENT', 'resolve', 'DEFAULT', 'admission-fixture');
  const other = await manager.create(otherWorkspace.id, 'CURSOR_AGENT', 'ordinary', 'DEFAULT', 'admission-fixture');
  const response = await app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/rebase`, payload: {} });
  expect(response.statusCode).toBe(409); expect(response.json().code).toBe('MERGE_CONFLICT');
  const token = response.json().resolutionContextToken;
  expect(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).recovery).toBeTruthy();
  return { sourcePath, sessionId: session.id, otherId: other.id, token };
}
