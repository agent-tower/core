import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { synchronizeDatabaseSchema } from './database-schema.js';
import { getDevPort } from '@agent-tower/shared';

// This fixture is deliberately frozen before sessionId became nullable. Using
// the current Prisma schema to seed would skip the populated-table upgrade.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const legacySchema = path.resolve(serverRoot, '../../scripts/fixtures/team-foundation-legacy.prisma');
const scratch = mkdtempSync(path.join(tmpdir(), 'tower-team-foundation-schema-'));
const template = path.join(scratch, 'baseline.db');
const { PrismaClient } = pkg;
type Database = InstanceType<typeof PrismaClient>;
type LegacyTable = { columns: string[]; primary: string[]; rows: unknown[] };
type LegacySnapshot = Record<string, LegacyTable>;
let db: Database;
let dbPath: string;
let baseline: LegacySnapshot;
let caseNumber = 0;
const timestamp = 1740000123456;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

const synchronize = (entryDir = path.join(serverRoot, 'src')) => synchronizeDatabaseSchema({
  dataDir: path.dirname(dbPath), dbPath,
  schemaPath: path.join(serverRoot, 'prisma/schema.prisma'), entryDir,
});

async function insert(target: Database, table: string, values: Record<string, string | number | null>) {
  const names = Object.keys(values);
  await target.$executeRawUnsafe(
    `INSERT INTO ${quote(table)} (${names.map(quote).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
    ...Object.values(values),
  );
}

async function snapshot(target = db, previous?: LegacySnapshot): Promise<LegacySnapshot> {
  const tables = previous ? Object.keys(previous) : (await target.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )).map(row => row.name);
  const result: LegacySnapshot = {};
  for (const table of tables) {
    const info = previous ? undefined : await target.$queryRawUnsafe<Array<{ name: string; pk: number | bigint }>>(`PRAGMA table_info(${quote(table)})`);
    const names = previous ? previous[table].columns : info!.map(row => row.name);
    const primary = previous ? previous[table].primary : info!.filter(row => Number(row.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(row => row.name);
    // Cast every legacy column, including timestamps and booleans, to compare
    // exact SQLite values independently of the generated client's new model.
    const rows = await target.$queryRawUnsafe(
      `SELECT ${names.map(name => `CAST(${quote(name)} AS TEXT) AS ${quote(name)}`).join(',')} FROM ${quote(table)} ORDER BY ${(primary.length ? primary : names).map(quote).join(',')}`,
    );
    result[table] = { columns: names, primary, rows: rows as unknown[] };
  }
  return result;
}

async function durableState() {
  return {
    schema: await db.$queryRawUnsafe("SELECT name,type,sql FROM sqlite_master ORDER BY type,name"),
    values: await snapshot(),
    version: await db.$queryRawUnsafe('PRAGMA schema_version'),
  };
}

async function assertIntegrity() {
  expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
  expect(await db.$queryRawUnsafe('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
}

async function assertNoBackfill(requireExistingRows = true) {
  for (const [table, fields] of [
    ['MessageDelivery', ['taskId', 'teamRunId', 'taskInputSnapshotId']],
    ['RoomMessage', ['deliveryId']],
    ['TeamRun', ['currentTaskInputSnapshotId']],
    ['WorkRequest', ['taskInputSnapshotId']],
    ['AgentInvocation', ['taskInputSnapshotId']],
  ] as const) {
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT ${fields.map(quote).join(',')} FROM ${quote(table)}`);
    if (requireExistingRows) expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) for (const field of fields) expect(row[field]).toBeNull();
  }
  expect(await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM TeamTaskInputSnapshot')).toEqual([{ n: 0n }]);
  expect(await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM TeamTaskInputAction')).toEqual([{ n: 0n }]);
  const sessionId = (await db.$queryRawUnsafe<Array<{ name: string; notnull: number | bigint }>>('PRAGMA table_info(MessageDelivery)')).find(row => row.name === 'sessionId');
  expect(Number(sessionId?.notnull)).toBe(0);
}

async function availablePort(port = 0) {
  const probe = createServer();
  return await new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => {
      const address = probe.address();
      const boundPort = typeof address === 'object' && address ? address.port : 0;
      probe.close(error => error ? reject(error) : resolve(boundPort));
    });
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.off('close', closed); reject(new Error(`Finite startup child did not exit within ${timeoutMs}ms`)); }, timeoutMs);
    const closed = () => { clearTimeout(timer); resolve(); };
    child.once('close', closed);
  });
}

/** Every server is owned by one finite test and stopped before this returns. */
async function runEntry(kind: 'cli' | 'index', fixtureDir: string, port: number, expectedFailure?: RegExp) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENT_TOWER_') || key.startsWith('PRISMA_')) delete env[key];
  env.AGENT_TOWER_DATA_DIR = path.dirname(dbPath);
  env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
  env.AGENT_TOWER_DISABLE_ACCESS_PASSWORD = '1';
  env.AGENT_TOWER_WEB_DIR = path.resolve(serverRoot, '../web/dist');
  const args = ['--import', path.join(serverRoot, 'node_modules/tsx/dist/loader.mjs'), path.join(serverRoot, 'src', `${kind}.ts`)];
  if (kind === 'cli') args.push('--data-dir', path.dirname(dbPath), '--host', '127.0.0.1', '--port', String(port), '--disable-access-password');
  else {
    // index intentionally derives its data directory from os.homedir rather
    // than AGENT_TOWER_DATA_DIR. Isolate only that OS function in the child;
    // do not mutate HOME or point the real entry at the user's dev database.
    const shim = path.join(fixtureDir, 'isolate-index-homedir.cjs');
    writeFileSync(shim, `const os = require('node:os');\nos.homedir = () => process.env.TOWER_FIXTURE_HOME;\nrequire('node:module').syncBuiltinESMExports();\nrequire('node:fs').writeFileSync(require('node:path').join(os.homedir(), 'index-home-marker'), os.homedir());\n`);
    env.TOWER_FIXTURE_HOME = fixtureDir;
    args.unshift('--require', shim);
    expect(dbPath).toBe(path.join(fixtureDir, '.agent-tower-dev', 'data.db'));
  }
  const child = spawn(process.execPath, args, { cwd: fixtureDir, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = '';
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream!.on('data', chunk => { logs = (logs + chunk.toString()).slice(-16_000); });
  try {
    if (expectedFailure) {
      await waitForExit(child, 30_000);
      if (spawnError) throw spawnError;
      expect(child.exitCode, logs).toBe(1);
      expect(logs).toMatch(expectedFailure);
      expect(logs).not.toMatch(/running on http|Server listening at|\[startup:onReady\]/);
    } else {
      const deadline = Date.now() + 30_000;
      let healthy = false;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Startup child exited before health: ${child.exitCode}/${child.signalCode}\n${logs}`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
          if (response.ok && (await response.json() as { status?: string }).status === 'ok') { healthy = true; break; }
        } catch { /* Bounded wait; no external provider or Agent is launched. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(healthy, logs).toBe(true);
      expect(existsSync(path.join(path.dirname(dbPath), 'internal-api-token'))).toBe(true);
      if (kind === 'index') expect(readFileSync(path.join(fixtureDir, 'index-home-marker'), 'utf8')).toBe(fixtureDir);
      child.send({ type: 'agent-tower:shutdown' });
      await waitForExit(child, 15_000);
      expect(child.exitCode, logs).toBe(0);
      expect(logs).toContain('Server closed');
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: 'agent-tower:shutdown' });
      try { await waitForExit(child, 5_000); }
      catch { child.kill('SIGKILL'); await waitForExit(child, 5_000); }
    }
  }
}

async function seedBaseline() {
  const seedCache = path.join(scratch, 'seed-cache');
  mkdirSync(seedCache, { recursive: true });
  execFileSync(process.execPath, [path.join(serverRoot, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', `--schema=${legacySchema}`], {
    env: { ...process.env, CACHE_DIR: seedCache, AGENT_TOWER_DATABASE_URL: `file:${template}` },
    stdio: 'pipe', timeout: 30_000,
  });
  const target = new PrismaClient({ datasources: { db: { url: `file:${template}` } } });
  try {
    await insert(target, 'Project', { id: 'project', name: 'Legacy team project', repoPath: scratch, createdAt: timestamp, updatedAt: timestamp });
    await insert(target, 'Task', { id: 'task', projectId: 'project', title: 'Exact title\t正文 ', description: '  body\n\n  ', status: 'DONE', priority: 7, position: 3, createdAt: timestamp, updatedAt: timestamp });
    await insert(target, 'AppSettings', { id: 'singleton', dataMigrationVersion: 2 });
    await insert(target, 'TranslationSettings', { id: 'singleton', enabled: 0, revision: 9, enableEpoch: 4, credentialRevision: 2, updatedAt: timestamp });
    await insert(target, 'Workspace', { id: 'workspace', taskId: 'task', branchName: 'legacy-team', worktreePath: scratch, workingDir: scratch, status: 'ABANDONED', creationSubmissionId: 'workspace-submission', creationFingerprint: 'workspace-fingerprint', createdAt: timestamp, updatedAt: timestamp });
    await insert(target, 'Conversation', { id: 'conversation', title: 'Exact independent conversation', directoryName: 'legacy-conversation', workingDir: scratch, createdAt: timestamp, updatedAt: timestamp });
    for (const [id, context] of [['session-task', 'WORKSPACE'], ['session-conversation', 'CONVERSATION'], ['session-team', 'WORKSPACE']] as const) {
      await insert(target, 'Session', { id, workspaceId: context === 'WORKSPACE' ? 'workspace' : null, conversationId: context === 'CONVERSATION' ? 'conversation' : null, context, agentType: 'CODEX', prompt: ' \nExact\t正文  \n', status: 'COMPLETED', creationSubmissionId: `${id}-submission`, creationFingerprint: `${id}-fingerprint`, inputIntent: '{"attachmentIds":["frozen-attachment"]}', createdAt: timestamp, updatedAt: timestamp });
    }
    for (const [id, sessionId, origin, sequence, state] of [
      ['delivery-initial', 'session-task', 'TASK_INITIAL', 1, 'SENT'],
      ['delivery-followup', 'session-task', 'TASK_FOLLOWUP', 2, 'TRANSLATION_FAILED'],
      ['delivery-conversation', 'session-conversation', 'CONVERSATION', 1, 'SENT'],
    ] as const) {
      await insert(target, 'MessageDelivery', {
        id, clientSubmissionId: `submission-${id}`, requestFingerprint: `fingerprint-${id}`, sessionId,
        channelKey: origin === 'CONVERSATION' ? 'conversation:conversation' : `session:${sessionId}`, sequence, origin,
        originalText: ` \nExact ${id}\t正文\n `, attachmentIds: '["frozen-attachment"]', intent: '{"retryTask":false}',
        sourceRevision: 3, sourceHash: `hash-${id}`, translationSourceId: `source-${id}`, enableEpoch: 4,
        requiresTranslation: 1, state, sentMode: state === 'SENT' ? 'TRANSLATED' : null,
        acceptedText: state === 'SENT' ? '  accepted\n\n ' : null, actualSentText: state === 'SENT' ? '  sent\n\n ' : null,
        sentAt: state === 'SENT' ? timestamp : null, acceptedDestinationId: state === 'SENT' ? sessionId : null,
        lastError: state === 'SENT' ? null : 'HTTP_503', revision: 5, createdAt: timestamp - 100, updatedAt: timestamp,
      });
      await insert(target, 'TranslationSource', { id: `source-${id}`, scopeType: origin === 'CONVERSATION' ? 'CONVERSATION' : 'SESSION', scopeId: origin === 'CONVERSATION' ? 'conversation' : sessionId, sourceKind: 'USER_DELIVERY', sourceKey: id, laneKey: origin === 'CONVERSATION' ? 'conversation:conversation' : `session:${sessionId}`, sessionId, deliveryId: id, direction: 'SEND', originalText: ` \nExact ${id}\t正文\n `, sourceRevision: 3, sourceHash: `hash-${id}`, blockState: 'SEALED', jobState: state === 'SENT' ? 'SUCCESS' : 'RETRY_WAIT', currentAttemptVersion: 2, effectiveAttemptId: state === 'SENT' ? `attempt-${id}` : null, generation: 4, enableEpoch: 4, retryChainId: 'frozen-retry-chain', retryCount: 2, budgetStartedAt: timestamp - 500, nextRetryAt: state === 'SENT' ? null : timestamp + 200, createdAt: timestamp - 100, updatedAt: timestamp });
      await insert(target, 'TranslationAttempt', { id: `attempt-${id}`, sourceId: `source-${id}`, sourceRevision: 3, sourceHash: `hash-${id}`, attemptVersion: 2, configRevision: 9, credentialRevision: 2, targetLanguage: 'English', sanitizedConfigSnapshot: '{}', protectionVersion: 'v1', status: state === 'SENT' ? 'SUCCESS' : 'RUNNING', resultText: state === 'SENT' ? '  accepted\n\n ' : null, generation: 4, enableEpoch: 4, retryIndex: 2, leaseOwner: state === 'SENT' ? null : 'old-worker', leaseExpiresAt: state === 'SENT' ? null : timestamp + 100, startedAt: timestamp - 20, completedAt: state === 'SENT' ? timestamp : null });
      await insert(target, 'DeliveryReceipt', { deliveryId: id, generation: 3, phase: state === 'SENT' ? 'SUBMITTED' : 'NOT_SUBMITTED', runtimeInstanceId: 'prior-runtime', turnId: `native-turn-${id}`, evidence: '  exact transport evidence\n ', submittedAt: state === 'SENT' ? timestamp : null, updatedAt: timestamp });
      await insert(target, 'DeliveryAction', { actionId: `action-${id}`, deliveryId: id, fingerprint: `action-fingerprint-${id}`, createdAt: timestamp - 10 });
    }
    await target.$executeRawUnsafe("UPDATE Session SET initialDeliveryId='delivery-initial' WHERE id='session-task'");
    await insert(target, 'ConversationTurn', { id: 'turn', sessionId: 'session-conversation', deliveryId: 'delivery-conversation', originalText: '  original conversation\n ', deliveryRevision: 5, message: '  sent\n\n ', userEntryId: 'frozen-user-entry', status: 'COMPLETED', attempts: 3, lastError: 'prior failure', queuedAt: timestamp - 20, startedAt: timestamp - 10, completedAt: timestamp, createdAt: timestamp - 20, updatedAt: timestamp });
    await insert(target, 'TeamRun', { id: 'team', taskId: 'task', mainWorkspaceId: 'workspace', mode: 'CONFIRM', reviewReason: 'TEAM_QUIESCENT', createdAt: timestamp, updatedAt: timestamp });
    await insert(target, 'TeamMember', { id: 'member', teamRunId: 'team', name: 'Legacy member', aliases: '["legacy"]', providerId: 'isolated-no-provider', rolePrompt: '  exact role\n ', capabilities: '{}', workspacePolicy: 'dedicated', triggerPolicy: 'MENTION_ONLY', membershipStatus: 'ACTIVE', status: 'IDLE', createdAt: timestamp, updatedAt: timestamp });
    for (const [id, visibility] of [['room-public', 'PUBLIC'], ['room-private', 'PRIVATE']] as const) {
      await insert(target, 'RoomMessage', { id, teamRunId: 'team', senderType: 'user', kind: 'chat', visibility, content: `  ${id}\n\n正文\t `, mentions: '[{"memberId":"member"}]', workRequestIds: '["request"]', artifactRefs: '[{"path":"keep.txt"}]', attachmentIds: '["frozen-attachment"]', translationEligibilityEpoch: null, createdAt: timestamp });
    }
    await insert(target, 'RoomMessageParticipant', { id: 'participant', teamRunId: 'team', roomMessageId: 'room-private', memberId: 'member', role: 'RECIPIENT', createdAt: timestamp });
    await insert(target, 'WorkRequest', { id: 'request', teamRunId: 'team', requesterType: 'user', targetMemberId: 'member', triggerMessageId: 'room-public', instruction: '  full instruction\n ', targetKind: 'WORKSPACE_COMMIT', targetPurpose: 'REVIEW', targetSourceWorkspaceId: 'workspace', targetHeadSha: 'a'.repeat(40), targetBranchName: 'legacy-target', status: 'COMPLETED', startAttemptCount: 2, lastStartError: 'prior retry', nextStartRetryAt: timestamp - 1, createdAt: timestamp, updatedAt: timestamp });
    await insert(target, 'AgentInvocation', { id: 'invocation', teamRunId: 'team', workRequestId: 'request', memberId: 'member', workspaceId: 'workspace', sessionId: 'session-team', targetKind: 'WORKSPACE_COMMIT', targetPurpose: 'REVIEW', targetSourceWorkspaceId: 'workspace', targetHeadSha: 'a'.repeat(40), targetBranchName: 'legacy-target', targetSyncStatus: 'READY', status: 'COMPLETED', roomReplyReminderCount: 2, lastHeartbeatAt: timestamp - 2, firstNudgeAt: timestamp - 4, createdAt: timestamp, updatedAt: timestamp });
    const sessionId = (await target.$queryRawUnsafe<Array<{ name: string; notnull: number | bigint }>>('PRAGMA table_info(MessageDelivery)')).find(row => row.name === 'sessionId');
    expect(Number(sessionId?.notnull)).toBe(1);
    return await snapshot(target);
  } finally { await target.$disconnect(); }
}

async function seedPreP3(targetPath: string) {
  execFileSync(process.execPath, [path.join(serverRoot, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', `--schema=${path.resolve(serverRoot, '../../scripts/fixtures/p3-legacy.prisma')}`], {
    env: { ...process.env, CACHE_DIR: path.join(scratch, 'pre-p3-cache'), AGENT_TOWER_DATABASE_URL: `file:${targetPath}` }, stdio: 'pipe', timeout: 30_000,
  });
  const source = new PrismaClient({ datasources: { db: { url: `file:${template}` } } });
  const target = new PrismaClient({ datasources: { db: { url: `file:${targetPath}` } } });
  try {
    for (const table of ['Project', 'Task', 'AppSettings', 'TranslationSettings', 'Workspace', 'Conversation', 'Session', 'TranslationSource', 'TranslationAttempt', 'ConversationTurn', 'TeamRun', 'TeamMember', 'RoomMessage', 'RoomMessageParticipant', 'WorkRequest', 'AgentInvocation']) {
      const names = (await target.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info(${quote(table)})`)).map(row => row.name);
      const rows = await source.$queryRawUnsafe<Array<Record<string, string | null>>>(`SELECT ${names.map(name => `CAST(${quote(name)} AS TEXT) AS ${quote(name)}`).join(',')} FROM ${quote(table)} ORDER BY rowid`);
      for (const values of rows) {
        // The older Source column was an unbound string. This database predates
        // deliveries, so retain no link to the baseline-only delivery fixture.
        if (table === 'TranslationSource') values.deliveryId = null;
        await insert(target, table, values);
      }
    }
  } finally { await Promise.all([source.$disconnect(), target.$disconnect()]); }
}

describe('team input foundation startup upgrade from populated 09b3baf schema', () => {
  beforeAll(async () => { baseline = await seedBaseline(); }, 30_000);
  beforeEach(() => {
    dbPath = path.join(scratch, `case-${caseNumber++}.db`);
    cpSync(template, dbPath);
    db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
  });
  afterEach(async () => { await db.$disconnect(); });
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

  it('supports the bundled Prisma nullable-session reconstruction without accepting data loss', async () => {
    execFileSync(process.execPath, [path.join(serverRoot, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', `--schema=${path.join(serverRoot, 'prisma/schema.prisma')}`], {
      env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}`, CACHE_DIR: path.join(scratch, 'cache') }, stdio: 'pipe', timeout: 30_000,
    });
    expect(await snapshot(db, baseline)).toEqual(baseline);
    await assertNoBackfill();
    await synchronize();
    expect(await snapshot(db, baseline)).toEqual(baseline);
    await assertIntegrity();
  }, 30_000);

  it('preserves every old value and relationship, changes sessionId nullability, and never backfills history', async () => {
    for (let cycle = 0; cycle < 2; cycle++) {
      await synchronize();
      expect(await snapshot(db, baseline)).toEqual(baseline);
      await assertNoBackfill();
      await assertIntegrity();
    }
  }, 30_000);

  it.each([false, true])('resumes a partial nullable room delivery addition with existing unique index=%s', async indexed => {
    await db.$executeRawUnsafe('ALTER TABLE RoomMessage ADD COLUMN deliveryId TEXT COLLATE BINARY');
    if (indexed) await db.$executeRawUnsafe('CREATE UNIQUE INDEX RoomMessage_deliveryId_key ON RoomMessage(deliveryId COLLATE BINARY)');
    await synchronize();
    expect(await snapshot(db, baseline)).toEqual(baseline);
    await assertNoBackfill();
    await assertIntegrity();
  }, 20_000);

  it('serializes two upgraders while preserving populated session deliveries and room requests', async () => {
    const outcomes = await Promise.allSettled([synchronize(), synchronize()]);
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    expect(await snapshot(db, baseline)).toEqual(baseline);
    await assertNoBackfill();
    await assertIntegrity();
  }, 30_000);

  it.each(['INTEGER', 'TEXT NOT NULL DEFAULT \'\'', 'TEXT DEFAULT NULL', 'TEXT DEFAULT \'unexpected\'', 'TEXT COLLATE NOCASE', 'TEXT COLLATE RTRIM'])('rejects incompatible RoomMessage.deliveryId before push: %s', async declaration => {
    await db.$executeRawUnsafe(`ALTER TABLE RoomMessage ADD COLUMN deliveryId ${declaration}`);
    const before = await durableState();
    await expect(synchronize()).rejects.toThrow(/schema prepare failed \(attempt 1\/3\)/);
    expect(await durableState()).toEqual(before);
  });

  it.each([
    'CREATE INDEX RoomMessage_deliveryId_key ON RoomMessage(deliveryId)',
    'CREATE UNIQUE INDEX RoomMessage_deliveryId_key ON RoomMessage(deliveryId) WHERE deliveryId IS NOT NULL',
    'CREATE UNIQUE INDEX RoomMessage_deliveryId_key ON RoomMessage(deliveryId COLLATE NOCASE)',
    'CREATE UNIQUE INDEX RoomMessage_deliveryId_key ON RoomMessage(id)',
    'CREATE UNIQUE INDEX RoomMessage_deliveryId_key ON MessageDelivery(id)',
  ])('rejects an incompatible room delivery index without changing the database: %s', async definition => {
    await db.$executeRawUnsafe('ALTER TABLE RoomMessage ADD COLUMN deliveryId TEXT');
    await db.$executeRawUnsafe(definition);
    const before = await durableState();
    await expect(synchronize()).rejects.toThrow(/schema prepare failed \(attempt 1\/3\)/);
    expect(await durableState()).toEqual(before);
  });

  it('rejects duplicate non-null room delivery IDs without exposing the duplicated value', async () => {
    await db.$executeRawUnsafe('ALTER TABLE RoomMessage ADD COLUMN deliveryId TEXT');
    await db.$executeRawUnsafe("UPDATE RoomMessage SET deliveryId='delivery-initial'");
    const before = await durableState();
    const error = await synchronize().then(() => undefined, failure => failure as Error);
    expect(error?.message).toMatch(/schema prepare failed \(attempt 1\/3\)/);
    expect(error?.message).not.toContain('delivery-initial');
    expect(await durableState()).toEqual(before);
  });

  it.each([
    ['RoomMessage', 'deliveryId'], ['MessageDelivery', 'taskId'], ['MessageDelivery', 'teamRunId'],
    ['MessageDelivery', 'taskInputSnapshotId'], ['TeamRun', 'currentTaskInputSnapshotId'],
    ['WorkRequest', 'taskInputSnapshotId'], ['AgentInvocation', 'taskInputSnapshotId'],
  ])('rejects dangling partial-upgrade %s.%s before push or recovery', async (table, field) => {
    await db.$executeRawUnsafe(`ALTER TABLE ${quote(table)} ADD COLUMN ${quote(field)} TEXT`);
    await db.$executeRawUnsafe(`UPDATE ${quote(table)} SET ${quote(field)}='private-orphan-reference'`);
    const before = await durableState();
    const error = await synchronize().then(() => undefined, failure => failure as Error);
    expect(error?.message).toMatch(/schema prepare failed \(attempt 1\/3\)/);
    expect(error?.message).not.toContain('private-orphan-reference');
    expect(await durableState()).toEqual(before);
  });

  it.each(['FORGED_ORIGIN', 'TEAM_USER', 'TEAM_INITIAL'])('rejects legacy delivery origin/destination mismatch %s before rewriting rows', async origin => {
    await db.$executeRawUnsafe('UPDATE MessageDelivery SET origin=? WHERE id=?', origin, 'delivery-followup');
    const before = await durableState();
    await expect(synchronize()).rejects.toThrow(/schema prepare failed \(attempt 1\/3\)/);
    expect(await durableState()).toEqual(before);
  });

  it('rejects an incomplete new snapshot table before push can normalize it', async () => {
    await db.$executeRawUnsafe('CREATE TABLE TeamTaskInputSnapshot(id TEXT NOT NULL PRIMARY KEY)');
    const before = await durableState();
    await expect(synchronize()).rejects.toThrow(/schema prepare failed \(attempt 1\/3\)/);
    expect(await durableState()).toEqual(before);
  });

  it('preserves a valid pending snapshot when its unique index was not created before interruption', async () => {
    await synchronize();
    await db.$executeRawUnsafe('DROP INDEX TeamTaskInputSnapshot_teamRunId_taskSourceHash_key');
    const taskSourceHash = createHash('sha256').update(JSON.stringify(['team-task-input-v1', 'exact', null])).digest('hex');
    await insert(db, 'TeamTaskInputSnapshot', { id: 'snapshot', teamRunId: 'team', taskId: 'task', taskSourceHash, originalTitle: 'exact', state: 'PENDING', createdAt: timestamp, updatedAt: timestamp });
    const before = await snapshot();
    await synchronize();
    expect(await snapshot(db, before)).toEqual(before);
    await assertIntegrity();
  }, 20_000);

  it('rejects duplicate snapshot identities after an interrupted missing-index upgrade', async () => {
    await synchronize();
    await db.$executeRawUnsafe('DROP INDEX TeamTaskInputSnapshot_teamRunId_taskSourceHash_key');
    const taskSourceHash = createHash('sha256').update(JSON.stringify(['team-task-input-v1', 'exact', '  description\n '])).digest('hex');
    for (const id of ['snapshot-1', 'snapshot-2']) await insert(db, 'TeamTaskInputSnapshot', {
      id, teamRunId: 'team', taskId: 'task', taskSourceHash,
      originalTitle: 'exact', originalDescription: '  description\n ', state: 'PENDING', createdAt: timestamp, updatedAt: timestamp,
    });
    const before = await durableState();
    const error = await synchronize().then(() => undefined, failure => failure as Error);
    expect(error?.message).toMatch(/schema prepare failed \(attempt 1\/3\)/);
    expect(error?.message).not.toContain(taskSourceHash);
    expect(await durableState()).toEqual(before);
  }, 20_000);

  it('rejects an incompatible new column without invoking Prisma push or later application work', async () => {
    await db.$executeRawUnsafe('ALTER TABLE RoomMessage ADD COLUMN deliveryId TEXT COLLATE NOCASE');
    await db.$executeRawUnsafe('CREATE UNIQUE INDEX RoomMessage_deliveryId_key ON RoomMessage(deliveryId COLLATE BINARY)');
    await db.$executeRawUnsafe('UPDATE AppSettings SET dataMigrationVersion=0');
    await db.$executeRawUnsafe('UPDATE Task SET title=?', 'long title '.repeat(50));
    await db.$executeRawUnsafe("UPDATE TranslationSource SET jobState='RUNNING'");
    const before = await durableState();
    const bundle = path.join(scratch, 'rejected-push-bundle');
    const marker = path.join(bundle, 'push-ran');
    mkdirSync(path.join(bundle, 'node_modules/prisma/build'), { recursive: true });
    writeFileSync(path.join(bundle, 'node_modules/prisma/build/index.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called')`);
    let resumed = false;
    await expect((async () => { await synchronize(path.join(bundle, 'dist')); resumed = true; })()).rejects.toThrow(/schema prepare failed \(attempt 1\/3\)/);
    expect(existsSync(marker)).toBe(false);
    expect(resumed).toBe(false);
    expect(await durableState()).toEqual(before);
  });

  it('upgrades one populated legacy database through two competing actual CLI entrants', async () => {
    await db.$disconnect();
    const fixtureDir = path.join(scratch, 'competing-actual-cli');
    const dataDir = path.join(fixtureDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    dbPath = path.join(dataDir, 'data.db');
    cpSync(template, dbPath);
    db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
    await db.$executeRawUnsafe("UPDATE TranslationSource SET jobState='SUCCESS',nextRetryAt=NULL");
    await db.$executeRawUnsafe("UPDATE TranslationAttempt SET status='SUCCESS',leaseOwner=NULL,leaseExpiresAt=NULL,completedAt=?", timestamp);
    await db.$executeRawUnsafe("UPDATE MessageDelivery SET state='CANCELLED' WHERE id='delivery-followup'");
    const facts = Object.fromEntries(Object.entries(await snapshot()).filter(([, table]) => table.rows.length > 0));
    const firstPort = await availablePort();
    let secondPort = await availablePort();
    for (let retry = 0; secondPort === firstPort && retry < 3; retry++) secondPort = await availablePort();
    expect(secondPort).not.toBe(firstPort);
    // Both child processes enter the ordinary CLI startup barrier against the
    // same database; separate listeners let each prove health and exit cleanly.
    const entrants = await Promise.allSettled([
      runEntry('cli', fixtureDir, firstPort), runEntry('cli', fixtureDir, secondPort),
    ]);
    for (const entrant of entrants) if (entrant.status === 'rejected') throw entrant.reason;
    expect(await snapshot(db, facts)).toEqual(facts);
    await assertNoBackfill();
    await assertIntegrity();
  }, 60_000);

  it.each([
    ['cli', 'baseline09'], ['index', 'baseline09'], ['cli', 'preP3'], ['index', 'preP3'],
  ] as const)('runs finite source %s startup twice from %s and rejects malformed structure before maintenance/workers', async (kind, legacyKind) => {
    await db.$disconnect();
    const fixtureDir = path.join(scratch, `actual-${kind}-${legacyKind}`);
    const dataDir = kind === 'index' ? path.join(fixtureDir, '.agent-tower-dev') : path.join(fixtureDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    dbPath = path.join(dataDir, 'data.db');
    if (legacyKind === 'preP3') await seedPreP3(dbPath);
    else cpSync(template, dbPath);
    db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
    // Startup's legitimate RUNNING recovery has separate tests. Keep this
    // fixture entirely inactive so no provider, process or translation starts.
    await db.$executeRawUnsafe("UPDATE TranslationSource SET jobState='SUCCESS',nextRetryAt=NULL");
    await db.$executeRawUnsafe("UPDATE TranslationAttempt SET status='SUCCESS',leaseOwner=NULL,leaseExpiresAt=NULL,completedAt=?", timestamp);
    if (legacyKind === 'baseline09') await db.$executeRawUnsafe("UPDATE MessageDelivery SET state='CANCELLED' WHERE id='delivery-followup'");
    const initial = await snapshot();
    // Normal startup may create defaults in empty settings tables. Existing
    // rows still retain all their exact fields, including inactive budgets.
    const facts = Object.fromEntries(Object.entries(initial).filter(([, table]) => table.rows.length > 0));
    const port = await availablePort(kind === 'index' ? getDevPort(path.resolve(serverRoot, '../..')) : 0);
    for (let cycle = 0; cycle < 2; cycle++) {
      await runEntry(kind, fixtureDir, port);
      expect(await snapshot(db, facts)).toEqual(facts);
      await assertNoBackfill(legacyKind === 'baseline09');
      await assertIntegrity();
    }
    await db.$executeRawUnsafe('DROP INDEX RoomMessage_deliveryId_key');
    await db.$executeRawUnsafe('CREATE UNIQUE INDEX RoomMessage_deliveryId_key ON RoomMessage(deliveryId) WHERE deliveryId IS NOT NULL');
    await db.$executeRawUnsafe('UPDATE AppSettings SET dataMigrationVersion=0');
    await db.$executeRawUnsafe('UPDATE Task SET title=?', 'long title '.repeat(50));
    await db.$executeRawUnsafe("UPDATE TranslationSource SET jobState='RUNNING'");
    await db.$executeRawUnsafe("UPDATE TranslationAttempt SET status='RUNNING'");
    const beforeRejection = await durableState();
    await runEntry(kind, fixtureDir, port, /schema prepare failed \(attempt 1\/3\)/);
    expect(await durableState()).toEqual(beforeRejection);
  }, 90_000);
});
