import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from '@prisma/client';
import { z } from 'zod';
import { prepareP3Database, synchronizeDatabaseSchema } from './database-schema.js';
// @ts-expect-error Shared install-level fixture is intentionally standalone JS.
import { seedLegacyDatabase, snapshotLegacyDatabase } from '../../../../scripts/p3-startup-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = mkdtempSync(path.join(tmpdir(), 'tower-p3-schema-'));
const template = path.join(scratch, 'legacy.db');
const { PrismaClient } = pkg;
let db: InstanceType<typeof PrismaClient>;
let dbPath: string;
let baseline: Record<string, unknown>;
let caseNumber = 0;
const sync = () => synchronizeDatabaseSchema({ dataDir: path.dirname(dbPath), dbPath, schemaPath: path.join(root, 'prisma/schema.prisma'), entryDir: path.join(root, 'src') });
async function snapshot() { return snapshotLegacyDatabase(db, baseline); }
async function sql(text: string) { await db.$executeRawUnsafe(text); }
const additions = [
  ['Workspace', 'creationSubmissionId'], ['Session', 'creationSubmissionId'], ['Session', 'initialDeliveryId'],
] as const;
const upperUuid = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const lowerUuid = upperUuid.toLowerCase();
async function lookupId(table: string, name: string, value: string) {
  if (table === 'Workspace') return db.workspace.findUnique({ where: { creationSubmissionId: value }, select: { id: true } });
  if (name === 'initialDeliveryId') return db.session.findUnique({ where: { initialDeliveryId: value }, select: { id: true } });
  return db.session.findUnique({ where: { creationSubmissionId: value }, select: { id: true } });
}
async function durableState() {
  const schema = await db.$queryRawUnsafe<Array<{ name: string; type: string; sql: string | null }>>(
    "SELECT name,type,sql FROM sqlite_master ORDER BY type,name",
  );
  const tables: Record<string, unknown> = {};
  for (const { name, type } of schema) if (type === 'table') {
    tables[name] = await db.$queryRawUnsafe(`SELECT * FROM "${name}" ORDER BY rowid`);
  }
  return { schema, tables, version: await db.$queryRawUnsafe('PRAGMA schema_version') };
}

describe('P3 startup schema barrier (isolated SQLite and real bundled Prisma)', () => {
  beforeAll(async () => { baseline = await seedLegacyDatabase(root, template, scratch); }, 30_000);
  beforeEach(() => {
    dbPath = path.join(scratch, `case-${caseNumber++}.db`);
    cpSync(template, dbPath);
    db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
  });
  afterEach(async () => { await db.$disconnect(); });
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

  it('demonstrates the original non-interactive push failure, then preserves every legacy value and Attempt', async () => {
    const { execFileSync } = await import('node:child_process');
    let originalFailure: { stdout?: Buffer; stderr?: Buffer } | undefined;
    try {
      execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', `--schema=${path.join(root, 'prisma/schema.prisma')}`], {
        env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}`, CACHE_DIR: path.join(scratch, 'cache') }, stdio: 'pipe', timeout: 30_000,
      });
    } catch (error) { originalFailure = error as typeof originalFailure; }
    expect(String(originalFailure?.stderr)).toContain('--accept-data-loss');
    expect(String(originalFailure?.stdout)).toContain('creationSubmissionId');
    expect(await snapshot()).toEqual(baseline);
    await sync();
    expect(await snapshot()).toEqual(baseline);
    await sync();
    expect(await snapshot()).toEqual(baseline);
    expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
    expect(await db.$queryRawUnsafe('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  }, 30_000);

  it('adds room eligibility through normal sync without rewriting legacy facts, retains zero across repeated sync', async () => {
    await sync();
    const column = (await db.$queryRawUnsafe<Array<{ name: string; type: string; notnull: bigint; dflt_value: string | null }>>('PRAGMA table_info(RoomMessage)')).find(row => row.name === 'translationEligibilityEpoch');
    expect(column).toMatchObject({ type: 'INTEGER', notnull: 0n, dflt_value: null });
    const indexes = await db.$queryRawUnsafe<Array<{ name: string; unique: bigint }>>('PRAGMA index_list(RoomMessage)');
    expect(indexes.find(row => row.name === 'RoomMessage_translationEligibilityEpoch_id_idx')?.unique).toBe(0n);
    const team = await db.teamRun.create({ data: { taskId: 'task', mode: 'CONFIRM' } });
    const message = await db.roomMessage.create({ data: { teamRunId: team.id, senderType: 'agent', kind: 'chat', content: '  exact\n\n', mentions: '[]', translationEligibilityEpoch: 0 } });
    await sync();
    expect(await db.roomMessage.findUnique({ where: { id: message.id } })).toEqual(message);
    expect(await snapshot()).toEqual(baseline);
  }, 20_000);

  it.each(['TEXT', 'INTEGER NOT NULL DEFAULT 0', 'INTEGER DEFAULT NULL', 'INTEGER DEFAULT 0'])('rejects incompatible room eligibility before push: %s', async definition => {
    await sql(`ALTER TABLE RoomMessage ADD COLUMN translationEligibilityEpoch ${definition}`);
    const before = await durableState();
    await expect(sync()).rejects.toThrow('schema prepare failed');
    expect(await durableState()).toEqual(before);
  });

  it.each([
    'CREATE UNIQUE INDEX RoomMessage_translationEligibilityEpoch_id_idx ON RoomMessage(translationEligibilityEpoch,id)',
    'CREATE INDEX RoomMessage_translationEligibilityEpoch_id_idx ON RoomMessage(id,translationEligibilityEpoch)',
    'CREATE INDEX RoomMessage_translationEligibilityEpoch_id_idx ON RoomMessage(translationEligibilityEpoch,id) WHERE translationEligibilityEpoch IS NOT NULL',
  ])('rejects an incompatible room index before any workers or push: %s', async definition => {
    await sql('ALTER TABLE RoomMessage ADD COLUMN translationEligibilityEpoch INTEGER');
    await sql(definition);
    const before = await durableState();
    await expect(sync()).rejects.toThrow('unexpected index definition');
    expect(await durableState()).toEqual(before);
  });

  it('supports a new database and multiple NULLs', async () => {
    await db.$disconnect();
    rmSync(dbPath);
    await sync();
    expect(await db.$queryRawUnsafe('SELECT * FROM Session')).toEqual([]);
  }, 20_000);

  it('keeps committed preparation retryable after a failed push and checks structure even if push exits zero', async () => {
    const fakeRoot = path.join(scratch, 'fake-bundle');
    const fakePrisma = path.join(fakeRoot, 'node_modules/prisma/build');
    mkdirSync(fakePrisma, { recursive: true });
    const options = { dataDir: scratch, dbPath, schemaPath: path.join(root, 'prisma/schema.prisma'), entryDir: path.join(fakeRoot, 'dist') };
    writeFileSync(path.join(fakePrisma, 'index.js'), 'process.exit(1)');
    await expect(synchronizeDatabaseSchema(options)).rejects.toThrow('schema push failed');
    expect(await snapshot()).toEqual(baseline);
    writeFileSync(path.join(fakePrisma, 'index.js'), 'process.exit(0)');
    await expect(synchronizeDatabaseSchema(options)).rejects.toThrow('schema verify failed');
    expect(await snapshot()).toEqual(baseline);
    await sync();
    expect(await snapshot()).toEqual(baseline);
  }, 20_000);

  it('preserves active/retry states through schema sync before recovery has begun', async () => {
    await sql("UPDATE TranslationSource SET jobState='RETRY_WAIT', nextRetryAt=1740000123460, errorCode='HTTP_503'");
    await sql("UPDATE TranslationAttempt SET status='RUNNING', leaseOwner='old-owner', leaseExpiresAt=1740000123460");
    const before = await snapshot();
    await sync();
    expect(await snapshot()).toEqual(before);
  }, 20_000);

  it('preserves upgraded delivery IDs and valid Source/Turn/Receipt/Action relationships', async () => {
    await sync();
    await db.messageDelivery.create({ data: {
      id: 'delivery', clientSubmissionId: 'submission', requestFingerprint: 'fingerprint',
      sessionId: 'session-CONVERSATION-0', channelKey: 'conversation:conversation-0', sequence: 1, origin: 'CONVERSATION',
      originalText: '  exact\n\n', sourceHash: 'hash', enableEpoch: 1, requiresTranslation: false,
      state: 'SENT', acceptedText: '  accepted\n', actualSentText: '  exact\n\n',
      receipt: { create: { generation: 1, phase: 'SUBMITTED', evidence: 'written' } },
      actions: { create: { actionId: 'action', fingerprint: 'action-fingerprint' } },
    } });
    await sql("UPDATE TranslationSource SET deliveryId='delivery' WHERE id='source-CONVERSATION-0'");
    await sql("UPDATE ConversationTurn SET deliveryId='delivery', originalText='  prior  ', deliveryRevision=2 WHERE id='turn-0'");
    const before = await snapshot();
    const turn = await db.conversationTurn.findUnique({ where: { id: 'turn-0' } });
    const delivery = await db.messageDelivery.findUnique({ where: { id: 'delivery' }, include: { receipt: true, actions: true } });
    await sync();
    expect(await snapshot()).toEqual(before);
    expect(await db.conversationTurn.findUnique({ where: { id: 'turn-0' } })).toEqual(turn);
    expect(await db.messageDelivery.findUnique({ where: { id: 'delivery' }, include: { receipt: true, actions: true } })).toEqual(delivery);
  }, 20_000);

  for (const phase of ['one-column', 'prepared', 'pushed']) it(`resumes after ${phase} interruption and preserves non-null IDs`, async () => {
    if (phase === 'one-column') await sql('ALTER TABLE Session ADD COLUMN creationSubmissionId TEXT');
    else await prepareP3Database(dbPath);
    if (phase === 'pushed') await sync();
    await sql("UPDATE Session SET creationSubmissionId='existing-' || id");
    await sync();
    await sql("UPDATE Session SET initialDeliveryId='initial-' || id");
    await sql("UPDATE Workspace SET creationSubmissionId='workspace-' || id");
    const ids = await db.$queryRawUnsafe('SELECT creationSubmissionId, initialDeliveryId FROM Session ORDER BY id');
    const workspaceIds = await db.$queryRawUnsafe('SELECT creationSubmissionId FROM Workspace ORDER BY id');
    await sync();
    expect(await db.$queryRawUnsafe('SELECT creationSubmissionId, initialDeliveryId FROM Session ORDER BY id')).toEqual(ids);
    expect(await db.$queryRawUnsafe('SELECT creationSubmissionId FROM Workspace ORDER BY id')).toEqual(workspaceIds);
    expect(await snapshot()).toEqual(baseline);
  }, 30_000);

  it('rolls back earlier DDL for duplicate non-null values without logging the value', async () => {
    await sql('ALTER TABLE Session ADD COLUMN creationSubmissionId TEXT');
    await sql("UPDATE Session SET creationSubmissionId='private-duplicate'");
    await expect(sync()).rejects.toThrow('Session_creationSubmissionId_key contains duplicate non-null values');
    expect((await db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info(Workspace)')).map(row => row.name)).not.toContain('creationSubmissionId');
    expect(await snapshot()).toEqual(baseline);
  });

  for (const definition of [
    'CREATE INDEX Session_creationSubmissionId_key ON Session(creationSubmissionId)',
    'CREATE UNIQUE INDEX Session_creationSubmissionId_key ON Session(creationSubmissionId) WHERE creationSubmissionId IS NOT NULL',
    'CREATE UNIQUE INDEX Session_creationSubmissionId_key ON Session(creationSubmissionId COLLATE NOCASE)',
    'CREATE UNIQUE INDEX Session_creationSubmissionId_key ON Workspace(id)',
  ]) it(`rejects heterogeneous indexes: ${definition}`, async () => {
    await sql('ALTER TABLE Session ADD COLUMN creationSubmissionId TEXT');
    await sql(definition);
    await expect(sync()).rejects.toThrow('unexpected index definition');
    expect(await snapshot()).toEqual(baseline);
  });

  it('rejects heterogeneous nullable ID columns', async () => {
    await sql('ALTER TABLE Session ADD COLUMN initialDeliveryId INTEGER');
    await expect(sync()).rejects.toThrow('Session.initialDeliveryId must be nullable TEXT');
    expect(await snapshot()).toEqual(baseline);
  });

  it('rejects inherited nonstandard column collation when adding its unique index', async () => {
    await sql('ALTER TABLE Session ADD COLUMN initialDeliveryId TEXT COLLATE NOCASE');
    await expect(sync()).rejects.toThrow('Session.initialDeliveryId must use BINARY column collation');
    expect(await snapshot()).toEqual(baseline);
  });

  for (const [table, name] of additions) for (const collation of ['NOCASE', 'RTRIM']) for (const indexed of [false, true]) {
    it(`rejects ${table}.${name} COLLATE ${collation} with ${indexed ? 'an explicit BINARY index' : 'no index'} before push`, async () => {
      await sql(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT COLLATE ${collation}`);
      if (indexed) await sql(`CREATE UNIQUE INDEX ${table}_${name}_key ON ${table}(${name} COLLATE BINARY)`);
      const ids = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM ${table} ORDER BY id`);
      await db.$executeRawUnsafe(`UPDATE ${table} SET ${name}=? WHERE id=?`, upperUuid, ids[0].id);
      await db.$executeRawUnsafe(`UPDATE ${table} SET ${name}=? WHERE id=?`, lowerUuid, ids[1].id);
      const before = await durableState();
      await expect(sync()).rejects.toThrow(`schema prepare failed (attempt 1/3): P3 schema incompatible: ${table}.${name} must use BINARY column collation`);
      expect(await durableState()).toEqual(before);
      expect(await snapshot()).toEqual(baseline);
      expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
      expect(await db.$queryRawUnsafe('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    });
  }

  for (const declaration of ['TEXT', 'TEXT COLLATE BINARY', 'TEXT COLLATE bInArY']) for (const indexed of [false, true]) {
    it(`accepts ${declaration} with ${indexed ? 'existing explicit BINARY indexes' : 'missing indexes'}, preserving case-sensitive UUID lookups and NULLs`, async () => {
      expect(z.string().uuid().parse(upperUuid)).toBe(upperUuid);
      expect(z.string().uuid().parse(lowerUuid)).toBe(lowerUuid);
      for (const [table, name] of additions) {
        await sql(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
        if (indexed) await sql(`CREATE UNIQUE INDEX ${table}_${name}_key ON ${table}(${name} COLLATE BINARY)`);
        const ids = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM ${table} ORDER BY id`);
        await db.$executeRawUnsafe(`UPDATE ${table} SET ${name}=? WHERE id=?`, upperUuid, ids[0].id);
        await db.$executeRawUnsafe(`UPDATE ${table} SET ${name}=? WHERE id=?`, lowerUuid, ids[1].id);
        if (table === 'Workspace') {
          // Two additional rows exercise multiple NULLs alongside the non-null IDs.
          for (const id of ['null-0', 'null-1']) await db.$executeRawUnsafe(
            'INSERT INTO Workspace(id,taskId,branchName,worktreePath,workingDir,status,createdAt,updatedAt) SELECT ?,taskId,branchName,worktreePath,workingDir,status,createdAt,updatedAt FROM Workspace LIMIT 1', id,
          );
        }
      }
      const before = await snapshotLegacyDatabase(db);
      await sync();
      for (const [table, name] of additions) {
        const ids = await db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM ${table} WHERE ${name} IS NOT NULL ORDER BY id`);
        expect(await lookupId(table, name, upperUuid)).toEqual({ id: ids[0].id });
        expect(await lookupId(table, name, lowerUuid)).toEqual({ id: ids[1].id });
        expect(await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM ${table} WHERE ${name} IS NULL`)).toEqual([{ n: 2n }]);
      }
      expect(await snapshotLegacyDatabase(db, before)).toEqual(before);
      // Verify the already-upgraded branch as well as the partial-upgrade branch.
      await sync();
      expect(await snapshotLegacyDatabase(db, before)).toEqual(before);
    }, 30_000);
  }

  it('never invokes push or resumes application work after incompatible column rejection', async () => {
    await sql('ALTER TABLE Session ADD COLUMN creationSubmissionId TEXT COLLATE NOCASE');
    await sql('CREATE UNIQUE INDEX Session_creationSubmissionId_key ON Session(creationSubmissionId COLLATE BINARY)');
    await sql('UPDATE AppSettings SET dataMigrationVersion=0');
    await db.$executeRawUnsafe('UPDATE Task SET title=?', 'long title '.repeat(50));
    await sql("UPDATE TranslationSource SET jobState='RUNNING'");
    const before = await durableState();
    const bundle = path.join(scratch, 'no-push-bundle');
    const marker = path.join(bundle, 'push-ran');
    mkdirSync(path.join(bundle, 'node_modules/prisma/build'), { recursive: true });
    writeFileSync(path.join(bundle, 'node_modules/prisma/build/index.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called')`);
    let recovered = false;
    await expect((async () => {
      await synchronizeDatabaseSchema({ dataDir: scratch, dbPath, schemaPath: path.join(root, 'prisma/schema.prisma'), entryDir: path.join(bundle, 'dist') });
      recovered = true;
    })()).rejects.toThrow('schema prepare failed (attempt 1/3)');
    expect(existsSync(marker)).toBe(false);
    expect(recovered).toBe(false);
    expect(await durableState()).toEqual(before);
  });

  for (const encoding of ['UTF-16le', 'UTF-16be']) for (const collation of ['BINARY', 'NOCASE']) {
    it(`checks empty ${encoding} columns using ${collation} semantics`, async () => {
      await db.$disconnect();
      rmSync(dbPath);
      await sql(`PRAGMA encoding='${encoding}'`);
      await sql(`CREATE TABLE Workspace(id TEXT PRIMARY KEY, creationSubmissionId TEXT COLLATE ${collation})`);
      await sql(`CREATE TABLE Session(id TEXT PRIMARY KEY, creationSubmissionId TEXT COLLATE ${collation}, initialDeliveryId TEXT COLLATE ${collation})`);
      const before = await durableState();
      if (collation === 'BINARY') {
        await prepareP3Database(dbPath);
        expect(await db.$queryRawUnsafe('SELECT * FROM Workspace')).toEqual([]);
        expect(await db.$queryRawUnsafe('SELECT * FROM Session')).toEqual([]);
      } else {
        await expect(prepareP3Database(dbPath)).rejects.toThrow('Workspace.creationSubmissionId must use BINARY column collation');
        expect(await durableState()).toEqual(before);
      }
    });
  }

  it('rechecks column collation after push even when all unique indexes remain BINARY', async () => {
    await sync();
    const before = await snapshotLegacyDatabase(db);
    const bundle = path.join(scratch, 'drifting-push-bundle');
    const script = path.join(bundle, 'drift.py');
    mkdirSync(path.join(bundle, 'node_modules/prisma/build'), { recursive: true });
    // Simulate an external schema change in the push gap, preserving all rows,
    // relationships and indexes. No production schema or migration is edited.
    writeFileSync(script, `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('PRAGMA foreign_keys=OFF')
c.execute('BEGIN')
definition=c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='Session'").fetchone()[0]
indexes=c.execute("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='Session' AND sql IS NOT NULL").fetchall()
assert '"creationSubmissionId" TEXT' in definition
definition=definition.replace('CREATE TABLE "Session"', 'CREATE TABLE "p3_drift"', 1).replace('"creationSubmissionId" TEXT', '"creationSubmissionId" TEXT COLLATE NOCASE', 1)
c.execute(definition)
c.execute('INSERT INTO p3_drift SELECT * FROM Session')
c.execute('DROP TABLE Session')
c.execute('ALTER TABLE p3_drift RENAME TO Session')
for (sql,) in indexes: c.execute(sql.replace('("creationSubmissionId")', '("creationSubmissionId" COLLATE BINARY)'))
c.commit()
c.close()
`);
    writeFileSync(path.join(bundle, 'node_modules/prisma/build/index.js'), `require('node:child_process').execFileSync('python3', ${JSON.stringify([script, dbPath])})`);
    await expect(synchronizeDatabaseSchema({ dataDir: scratch, dbPath, schemaPath: path.join(root, 'prisma/schema.prisma'), entryDir: path.join(bundle, 'dist') }))
      .rejects.toThrow('schema verify failed (attempt 1/3): P3 schema incompatible: Session.creationSubmissionId must use BINARY column collation');
    expect(await snapshotLegacyDatabase(db, before)).toEqual(before);
    expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
    expect(await db.$queryRawUnsafe('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  }, 20_000);

  for (const table of ['TranslationSource', 'ConversationTurn']) it(`rejects ${table} delivery orphans before push`, async () => {
    if (table === 'ConversationTurn') await sql('ALTER TABLE ConversationTurn ADD COLUMN deliveryId TEXT');
    await sql(`UPDATE ${table} SET deliveryId='orphan-secret'`);
    const before = await snapshot();
    await expect(sync()).rejects.toThrow(`${table}.deliveryId references missing MessageDelivery`);
    expect(await snapshot()).toEqual(before);
  });

  it.each([1, 2, 3, 4])('serializes preparation and recovers bounded simultaneous Prisma pushes (%d)', async () => {
    const results = await Promise.allSettled([sync(), sync()]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    expect(await snapshot()).toEqual(baseline);
    expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
  }, 30_000);

  for (const releaseEarly of [true, false]) it(`handles BUSY with ${releaseEarly ? 'bounded retry after release' : 'bounded failure and later retry'}`, async () => {
    const locker = spawn('python3', ['-c', 'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]); c.execute("BEGIN IMMEDIATE"); print("locked",flush=True); sys.stdin.readline(); c.rollback(); c.close()', dbPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => { locker.stdout.once('data', () => resolve()); locker.once('error', reject); });
    const closed = new Promise<void>(resolve => locker.once('close', () => resolve()));
    let timer: NodeJS.Timeout | undefined;
    try {
      if (releaseEarly) timer = setTimeout(() => locker.stdin.end('\n'), 400);
      if (releaseEarly) await sync();
      else await expect(sync()).rejects.toThrow(/attempt 3\/3/);
    } finally {
      clearTimeout(timer);
      locker.stdin.end('\n');
      await closed;
    }
    await sync();
    expect(await snapshot()).toEqual(baseline);
  }, 30_000);
});
