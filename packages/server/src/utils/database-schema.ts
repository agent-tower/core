import { assertTaskInputSnapshot } from '../services/team-task-input.js';
import { readTeamDeliveryIntent, verifyPublishedTeamDelivery } from '../services/team-room-delivery.js';
import pkg, { type Prisma } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { getBundledPrismaCommand } from './process-launch.js';
import { preparePrismaCliEnv } from './prisma-cli-env.js';

const { PrismaClient } = pkg;
const execFileAsync = promisify(execFile);
type Database = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;
type Column = { name: string; type: string; notnull: number | bigint; pk: number | bigint; dflt_value: string | null; hidden: number | bigint };
const additions = [
  ['Workspace', 'creationSubmissionId'],
  ['Session', 'creationSubmissionId'],
  ['Session', 'initialDeliveryId'],
  ['RoomMessage', 'deliveryId'],
] as const;

// Nullable UNIQUE additions need preparation. Other changes remain
// owned by the bundled Prisma schema sync; this is not a migration runner.
class CompatibilityError extends Error {}
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const incompatible = (constraint: string): never => { throw new CompatibilityError(`P3 schema incompatible: ${constraint}`); };

async function hasTable(db: Database, table: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?", table,
  );
  return rows.length !== 0;
}

async function columns(db: Database, table: string): Promise<Column[]> {
  return db.$queryRawUnsafe(`PRAGMA table_xinfo(${quote(table)})`);
}

function checkColumn(column: Column | undefined, table: string, name: string, type: string, nullable: boolean, primary = false) {
  if (!column || column.type.toUpperCase() !== type || Boolean(Number(column.notnull)) === nullable
    || Boolean(Number(column.pk)) !== primary || Number(column.hidden) !== 0) {
    incompatible(`${table}.${name} must be ${nullable ? 'nullable' : 'required'} ${type}${primary ? ' primary key' : ''}`);
  }
}

async function checkColumnCollation(db: Database, table: string, name: string) {
  // table_xinfo omits collation, and an index can override its column's rule.
  // Compile a comparison using the column itself, with no COLLATE or index.
  // EXPLAIN does not execute it: no row scan, probe DDL, or user values needed.
  const program = await db.$queryRawUnsafe<Array<{ opcode: string; p4: string | null }>>(
    `EXPLAIN SELECT ${quote(name)} = ? FROM ${quote(table)} NOT INDEXED`, '',
  );
  const comparisons = program.filter(row => row.opcode === 'Eq');
  // SQLite's VDBE format is version dependent. Fail closed if a future engine
  // cannot establish BINARY, including all three supported text encodings.
  if (comparisons.length !== 1 || !/^BINARY-(?:8|16LE|16BE)$/.test(comparisons[0].p4 ?? '')) {
    incompatible(`${table}.${name} must use BINARY column collation`);
  }
}

async function checkUnique(db: Database, table: string, names: readonly string[], create: boolean) {
  const index = `${table}_${names.join('_')}_key`;
  const existing = await db.$queryRawUnsafe<Array<{ tbl_name: string }>>(
    "SELECT tbl_name FROM sqlite_master WHERE name=?", index,
  );
  if (existing.length) {
    const indexes = await db.$queryRawUnsafe<Array<{ name: string; unique: number | bigint; partial: number | bigint; origin: string }>>(`PRAGMA index_list(${quote(table)})`);
    const shape = indexes.find(row => row.name === index);
    const info = await db.$queryRawUnsafe<Array<{ name: string | null; key: number | bigint; desc: number | bigint; coll: string; cid: number | bigint }>>(`PRAGMA index_xinfo(${quote(index)})`);
    const keys = info.filter(row => Number(row.key) === 1);
    if (existing[0].tbl_name !== table || !shape || Number(shape.unique) !== 1 || Number(shape.partial) !== 0
      || shape.origin !== 'c' || keys.length !== names.length
      || keys.some((row, i) => row.name !== names[i] || Number(row.cid) < 0 || Number(row.desc) !== 0 || row.coll.toUpperCase() !== 'BINARY')) {
      incompatible(`${index} has an unexpected index definition`);
    }
    return;
  }
  if (!create) incompatible(`${index} is missing`);
  const duplicate = await db.$queryRawUnsafe<Array<{ found: number }>>(
    `SELECT 1 AS found FROM ${quote(table)} WHERE ${names.map(name => `${quote(name)} IS NOT NULL`).join(' AND ')} GROUP BY ${names.map(quote).join(',')} HAVING COUNT(*) > 1 LIMIT 1`,
  );
  // Never include the duplicated value (possibly user content) in diagnostics.
  if (duplicate.length) incompatible(`${index} contains duplicate non-null values`);
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX ${quote(index)} ON ${quote(table)}(${names.map(quote).join(',')})`);
  // Validate the newly created index just as strictly as an existing one.
  await checkUnique(db, table, names, false);
}

async function checkIntegrity(db: Database) {
  const foreignKeys = await db.$queryRawUnsafe<Array<{ table: string; fkid: number | bigint }>>('PRAGMA foreign_key_check');
  if (foreignKeys.length) incompatible(`foreign_key_check failed for ${foreignKeys[0].table} constraint ${foreignKeys[0].fkid}`);
  const integrity = await db.$queryRawUnsafe<Array<{ integrity_check: string }>>('PRAGMA integrity_check');
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') incompatible('integrity_check failed');
}

// This nullable, non-unique addition belongs to normal Prisma sync. Inspect
// existing structure before push so an incompatible definition cannot be
// silently rebuilt/normalized, and require the complete structure afterwards.
async function checkRoomTranslationEligibility(db: Database, required: boolean) {
  const table = 'RoomMessage';
  const name = 'translationEligibilityEpoch';
  if (!await hasTable(db, table)) { if (required) incompatible('RoomMessage is missing'); return; }
  const column = (await columns(db, table)).find(row => row.name === name);
  if (column) {
    checkColumn(column, table, name, 'INTEGER', true);
    if (column.dflt_value !== null) incompatible(`${table}.${name} must have no default`);
  } else if (required) incompatible(`${table}.${name} is missing`);
  const index = 'RoomMessage_translationEligibilityEpoch_id_idx';
  const existing = await db.$queryRawUnsafe<Array<{ tbl_name: string }>>('SELECT tbl_name FROM sqlite_master WHERE name=?', index);
  if (!existing.length) { if (required) incompatible(`${index} is missing`); return; }
  const indexes = await db.$queryRawUnsafe<Array<{ name: string; unique: number | bigint; partial: number | bigint; origin: string }>>('PRAGMA index_list("RoomMessage")');
  const shape = indexes.find(row => row.name === index);
  const info = await db.$queryRawUnsafe<Array<{ name: string | null; key: number | bigint; desc: number | bigint; coll: string; cid: number | bigint }>>(`PRAGMA index_xinfo(${quote(index)})`);
  const keys = info.filter(row => Number(row.key) === 1);
  if (existing[0].tbl_name !== table || !column || !shape || Number(shape.unique) !== 0 || Number(shape.partial) !== 0 || shape.origin !== 'c'
    || keys.length !== 2 || keys.some((row, i) => row.name !== [name, 'id'][i] || Number(row.cid) < 0 || Number(row.desc) !== 0 || row.coll.toUpperCase() !== 'BINARY')) {
    incompatible(`${index} has an unexpected index definition`);
  }
}

async function checkDeliveryReferences(db: Database) {
  const destinationExists = await hasTable(db, 'MessageDelivery');
  for (const table of ['TranslationSource', 'ConversationTurn', 'RoomMessage']) {
    if (!await hasTable(db, table) || !(await columns(db, table)).some(row => row.name === 'deliveryId')) continue;
    const orphan = await db.$queryRawUnsafe<Array<{ found: number }>>(
      `SELECT 1 AS found FROM ${quote(table)} AS source WHERE source.deliveryId IS NOT NULL${destinationExists ? ' AND NOT EXISTS (SELECT 1 FROM MessageDelivery AS destination WHERE destination.id=source.deliveryId)' : ''} LIMIT 1`,
    );
    if (orphan.length) incompatible(`${table}.deliveryId references missing MessageDelivery`);
  }
}

// Structure checks run before push as well: Prisma must not normalize malformed new contracts.
const teamColumns: Array<[string, string, string, boolean, boolean?]> = [
  ...['taskId', 'teamRunId', 'taskInputSnapshotId'].map(name => ['MessageDelivery', name, 'TEXT', true] as [string, string, string, boolean]),
  ['TeamRun', 'currentTaskInputSnapshotId', 'TEXT', true], ['WorkRequest', 'taskInputSnapshotId', 'TEXT', true], ['AgentInvocation', 'taskInputSnapshotId', 'TEXT', true],
  ...['id','teamRunId','taskId','taskSourceHash','originalTitle','state'].map(name => ['TeamTaskInputSnapshot',name,'TEXT',false,name === 'id'] as [string,string,string,boolean,boolean]),
  ...['originalDescription','effectiveUserText','translationSourceId','acceptedAttemptId','sentMode'].map(name => ['TeamTaskInputSnapshot',name,'TEXT',true] as [string,string,string,boolean]),
  ['TeamTaskInputSnapshot','acceptedAt','DATETIME',true], ['TeamTaskInputSnapshot','revision','INTEGER',false], ['TeamTaskInputSnapshot','createdAt','DATETIME',false], ['TeamTaskInputSnapshot','updatedAt','DATETIME',false],
  ...['actionId','snapshotId','fingerprint'].map(name => ['TeamTaskInputAction',name,'TEXT',false,name === 'actionId'] as [string,string,string,boolean,boolean]),
  ['TeamTaskInputAction','createdAt','DATETIME',false],
];
const teamIndexes: Array<[string, string[], boolean]> = [
  ['MessageDelivery',['taskId','sequence'],false], ['MessageDelivery',['teamRunId','sequence'],false], ['MessageDelivery',['taskInputSnapshotId'],false], ['MessageDelivery',['channelKey','state','sequence'],false],
  ['TeamTaskInputSnapshot',['teamRunId','taskSourceHash'],true], ['TeamTaskInputSnapshot',['translationSourceId'],true], ['TeamTaskInputSnapshot',['teamRunId','state'],false], ['WorkRequest',['taskInputSnapshotId','status'],false],
];
const teamKeys = [
  ['RoomMessage','deliveryId','MessageDelivery','CASCADE'], ['MessageDelivery','taskId','Task','CASCADE'], ['MessageDelivery','teamRunId','TeamRun','CASCADE'], ['MessageDelivery','taskInputSnapshotId','TeamTaskInputSnapshot','SET NULL'],
  ['TeamRun','currentTaskInputSnapshotId','TeamTaskInputSnapshot','SET NULL'], ['WorkRequest','taskInputSnapshotId','TeamTaskInputSnapshot','SET NULL'], ['AgentInvocation','taskInputSnapshotId','TeamTaskInputSnapshot','SET NULL'],
  ['TeamTaskInputSnapshot','teamRunId','TeamRun','CASCADE'], ['TeamTaskInputSnapshot','taskId','Task','CASCADE'], ['TeamTaskInputSnapshot','translationSourceId','TranslationSource','SET NULL'], ['TeamTaskInputSnapshot','acceptedAttemptId','TranslationAttempt','SET NULL'], ['TeamTaskInputAction','snapshotId','TeamTaskInputSnapshot','CASCADE'],
];
async function checkTeamStructure(db: Database, required: boolean) {
  for (const [table,name,type,nullable,primary] of teamColumns) {
    if (!await hasTable(db,table)) { if (required) incompatible(`${table} is missing`); continue; }
    const column = (await columns(db,table)).find(c => c.name === name);
    if (!column) { if (required || table.startsWith('TeamTaskInput')) incompatible(`${table}.${name} is missing`); continue; }
    checkColumn(column,table,name,type,nullable,primary);
    if (nullable && column.dflt_value !== null) incompatible(`${table}.${name} must have no default`);
    if (type === 'TEXT') await checkColumnCollation(db,table,name);
  }
  if (await hasTable(db,'MessageDelivery')) {
    const session = (await columns(db,'MessageDelivery')).find(c => c.name === 'sessionId');
    checkColumn(session,'MessageDelivery','sessionId','TEXT', required ? true : Number(session?.notnull) === 0);
    await checkColumnCollation(db,'MessageDelivery','sessionId');
  }
  for (const [table,names,unique] of teamIndexes) {
    const index = `${table}_${names.join('_')}_${unique ? 'key' : 'idx'}`;
    const existing = await db.$queryRawUnsafe<Array<{name:string}>>('SELECT name FROM sqlite_master WHERE name=?',index);
    if (!existing.length) {
      if (required) incompatible(`${index} is missing`);
      if (unique && await hasTable(db,table)) {
        const duplicate = await db.$queryRawUnsafe<Array<{found:number}>>(`SELECT 1 AS found FROM ${quote(table)} WHERE ${names.map(n=>`${quote(n)} IS NOT NULL`).join(' AND ')} GROUP BY ${names.map(quote).join(',')} HAVING COUNT(*)>1 LIMIT 1`);
        if (duplicate.length) incompatible(`${index} contains duplicate non-null values`);
        await checkUnique(db,table,names,true);
      }
      continue;
    }
    if (unique) { await checkUnique(db,table,names,false); continue; }
    const indexes = await db.$queryRawUnsafe<Array<{name:string;unique:bigint;partial:bigint;origin:string}>>(`PRAGMA index_list(${quote(table)})`);
    const shape = indexes.find(i=>i.name === index);
    const keys = (await db.$queryRawUnsafe<Array<{name:string;key:bigint;desc:bigint;coll:string;cid:bigint}>>(`PRAGMA index_xinfo(${quote(index)})`)).filter(i=>Number(i.key) === 1);
    if (!shape || Number(shape.unique) !== 0 || Number(shape.partial) !== 0 || shape.origin !== 'c' || keys.length !== names.length || keys.some((k,i)=>k.name !== names[i] || Number(k.desc) !== 0 || Number(k.cid) < 0 || k.coll.toUpperCase() !== 'BINARY')) incompatible(`${index} has an unexpected index definition`);
  }
  for (const [table,from,target,deletion] of teamKeys) {
    if (!await hasTable(db,table) || !(await columns(db,table)).some(c=>c.name === from)) { if (required) incompatible(`${table}.${from} foreign key is missing`); continue; }
    const keys = await db.$queryRawUnsafe<Array<{table:string;from:string;to:string;on_delete:string;on_update:string}>>(`PRAGMA foreign_key_list(${quote(table)})`);
    if ((required || table.startsWith('TeamTaskInput') || keys.some(k=>k.from === from)) && !keys.some(k=>k.table === target && k.from === from && k.to === 'id' && k.on_delete === deletion && k.on_update === 'CASCADE')) incompatible(`${table}.${from} foreign key is missing or incompatible`);
  }
}
async function checkTeamFacts(db: Prisma.TransactionClient) {
  if (await hasTable(db,'MessageDelivery')) {
    const names = new Set((await columns(db,'MessageDelivery')).map(c=>c.name));
    const present = ['taskId','teamRunId','taskInputSnapshotId'].filter(n=>names.has(n));
    const legacyBad = await db.$queryRawUnsafe<Array<{id:string}>>(`SELECT id FROM MessageDelivery WHERE origin NOT IN ('TASK_INITIAL','TASK_FOLLOWUP','CONVERSATION','TEAM_USER','TEAM_INITIAL') OR (origin IN ('TASK_INITIAL','TASK_FOLLOWUP','CONVERSATION') AND (sessionId IS NULL${present.map(n=>` OR ${quote(n)} IS NOT NULL`).join('')})) LIMIT 1`);
    if (legacyBad.length) incompatible('MessageDelivery origin/destination shape is invalid');
    const badLegacyScope = await db.$queryRawUnsafe<Array<{id:string}>>(`SELECT d.id FROM MessageDelivery d LEFT JOIN Session s ON s.id=d.sessionId WHERE d.origin IN ('TASK_INITIAL','TASK_FOLLOWUP','CONVERSATION') AND (s.id IS NULL OR (d.origin='CONVERSATION' AND (s.conversationId IS NULL OR d.channelKey<>'conversation:' || s.conversationId)) OR (d.origin<>'CONVERSATION' AND (s.conversationId IS NOT NULL OR d.channelKey<>'session:' || s.id))) LIMIT 1`);
    if (badLegacyScope.length) incompatible('MessageDelivery session origin/scope is invalid');
    if (!names.has('taskId') || !names.has('teamRunId')) {
      const teams = await db.$queryRawUnsafe<Array<{id:string}>>("SELECT id FROM MessageDelivery WHERE origin IN ('TEAM_USER','TEAM_INITIAL') LIMIT 1");
      if (teams.length) incompatible('MessageDelivery team destination is invalid');
    }
    if (names.has('taskId') && names.has('teamRunId')) {
      const bad = await db.$queryRawUnsafe<Array<{id:string}>>(`SELECT d.id FROM MessageDelivery d LEFT JOIN TeamRun t ON t.id=d.teamRunId WHERE d.origin IN ('TEAM_USER','TEAM_INITIAL') AND (d.sessionId IS NOT NULL OR d.taskId IS NULL OR d.channelKey <> 'task:' || d.taskId || ':team-room' OR (d.origin='TEAM_USER' AND d.teamRunId IS NULL) OR (d.teamRunId IS NOT NULL AND (t.id IS NULL OR t.taskId<>d.taskId))) LIMIT 1`);
      if (bad.length) incompatible('MessageDelivery team destination is invalid');
    }
  }
  if (!await hasTable(db,'TeamTaskInputSnapshot')) {
    for (const [table,column] of [['TeamRun','currentTaskInputSnapshotId'],['WorkRequest','taskInputSnapshotId'],['AgentInvocation','taskInputSnapshotId'],['MessageDelivery','taskInputSnapshotId']]) {
      if (!(await columns(db,table)).some(c=>c.name === column)) continue;
      const refs = await db.$queryRawUnsafe<Array<{id:string}>>(`SELECT id FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL LIMIT 1`);
      if (refs.length) incompatible(`${table}.${column} references missing TeamTaskInputSnapshot`);
    }
    return;
  }
  const badSnapshot = await db.$queryRawUnsafe<Array<{id:string}>>(`SELECT s.id FROM TeamTaskInputSnapshot s LEFT JOIN TeamRun t ON t.id=s.teamRunId WHERE t.id IS NULL OR t.taskId<>s.taskId LIMIT 1`);
  if (badSnapshot.length) incompatible('Team task input facts are invalid');
  // Validate every saved input, including unreferenced/current/Invocation-only
  // acceptance. Do not restrict evidence checks to published delivery history.
  const snapshots = await db.teamTaskInputSnapshot.findMany();
  for (const snapshot of snapshots) {
    try { await assertTaskInputSnapshot(db, snapshot); } catch { incompatible('Team task input facts are invalid'); }
  }
  for (const [table,column] of [['TeamRun','currentTaskInputSnapshotId'],['WorkRequest','taskInputSnapshotId'],['AgentInvocation','taskInputSnapshotId'],['MessageDelivery','taskInputSnapshotId']]) {
    if (!(await columns(db,table)).some(c=>c.name === column)) continue;
    const bad = await db.$queryRawUnsafe<Array<{id:string}>>(`SELECT r.id FROM ${quote(table)} r LEFT JOIN TeamTaskInputSnapshot s ON s.id=r.${quote(column)} WHERE r.${quote(column)} IS NOT NULL AND (s.id IS NULL OR s.teamRunId<>${table === 'TeamRun' ? 'r.id' : 'r.teamRunId'}${['TeamRun','AgentInvocation'].includes(table) ? " OR s.state<>'ACCEPTED'" : ''}) LIMIT 1`);
    if (bad.length) incompatible(`${table}.${column} is inconsistent`);
  }
}

async function withDatabase(dbPath: string, action: (db: InstanceType<typeof PrismaClient>) => Promise<void>) {
  // Do not import utils/index: its singleton and application services belong to
  // the later runtime lifecycle, after the entry point has set its environment.
  const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
  try {
    await db.$queryRawUnsafe('PRAGMA busy_timeout = 250');
    await action(db);
  } finally {
    await db.$disconnect();
  }
}

export async function prepareP3Database(dbPath: string): Promise<void> {
  await withDatabase(dbPath, async db => {
    await checkIntegrity(db);
    await db.$transaction(async tx => {
      await checkRoomTranslationEligibility(tx, false);
      await checkTeamStructure(tx, false);
      await checkTeamFacts(tx);
      await checkDeliveryReferences(tx);
      for (const [table, name] of additions) {
        if (!await hasTable(tx, table)) continue;
        const column = (await columns(tx, table)).find(row => row.name === name);
        if (column) {
          checkColumn(column, table, name, 'TEXT', true);
          if (column.dflt_value !== null) incompatible(`${table}.${name} has an unexpected default`);
        } else {
          await tx.$executeRawUnsafe(`ALTER TABLE ${quote(table)} ADD COLUMN ${quote(name)} TEXT`);
        }
        await checkColumnCollation(tx, table, name);
        await checkUnique(tx, table, [name], true);
      }
    }, { maxWait: 1_000, timeout: 5_000 });
  });
}

async function verifyP3Database(dbPath: string): Promise<void> {
  await withDatabase(dbPath, async db => {
    await db.$transaction(async tx => {
      await checkRoomTranslationEligibility(tx, true);
      await checkTeamStructure(tx, true);
      await checkTeamFacts(tx);
      const expected: Array<[string, string, string, boolean, boolean?]> = [
        ...additions.map(([table, name]) => [table, name, 'TEXT', true] as [string, string, string, boolean]),
        ['Workspace', 'creationFingerprint', 'TEXT', true],
        ['Session', 'creationFingerprint', 'TEXT', true], ['Session', 'inputIntent', 'TEXT', true],
        ['ConversationTurn', 'deliveryId', 'TEXT', true], ['ConversationTurn', 'originalText', 'TEXT', true],
        ['ConversationTurn', 'deliveryRevision', 'INTEGER', true], ['TranslationSource', 'deliveryId', 'TEXT', true],
      ];
      const deliveryTypes: Record<string, string> = { sequence: 'INTEGER', sourceRevision: 'INTEGER', enableEpoch: 'INTEGER', requiresTranslation: 'BOOLEAN', revision: 'INTEGER', sentAt: 'DATETIME', createdAt: 'DATETIME', updatedAt: 'DATETIME' };
      const optional = new Set(['sessionId', 'translationSourceId', 'sentMode', 'acceptedText', 'actualSentText', 'sentAt', 'acceptedDestinationId', 'lastError']);
      for (const name of ['id', 'clientSubmissionId', 'requestFingerprint', 'sessionId', 'channelKey', 'sequence', 'origin', 'originalText', 'attachmentIds', 'intent', 'sourceRevision', 'sourceHash', 'translationSourceId', 'enableEpoch', 'requiresTranslation', 'state', 'sentMode', 'acceptedText', 'actualSentText', 'sentAt', 'acceptedDestinationId', 'lastError', 'revision', 'createdAt', 'updatedAt']) {
        expected.push(['MessageDelivery', name, deliveryTypes[name] ?? 'TEXT', optional.has(name), name === 'id']);
      }
      for (const [name, type, nullable] of [
        ['deliveryId', 'TEXT', false], ['generation', 'INTEGER', false], ['phase', 'TEXT', false],
        ['runtimeInstanceId', 'TEXT', true], ['turnId', 'TEXT', true], ['evidence', 'TEXT', true],
        ['submittedAt', 'DATETIME', true], ['updatedAt', 'DATETIME', false],
      ] as const) expected.push(['DeliveryReceipt', name, type, nullable, name === 'deliveryId']);
      for (const name of ['actionId', 'deliveryId', 'fingerprint', 'createdAt']) {
        expected.push(['DeliveryAction', name, name === 'createdAt' ? 'DATETIME' : 'TEXT', false, name === 'actionId']);
      }
      const tableColumns = new Map<string, Column[]>();
      for (const [table, name, type, nullable, primary] of expected) {
        if (!tableColumns.has(table)) tableColumns.set(table, await columns(tx, table));
        checkColumn(tableColumns.get(table)!.find(row => row.name === name), table, name, type, nullable, primary);
      }
      for (const [table, name] of additions) await checkColumnCollation(tx, table, name);
      for (const [table, names] of [
        ...additions.map(([table, name]) => [table, [name]] as const),
        ['ConversationTurn', ['deliveryId']], ['MessageDelivery', ['clientSubmissionId']],
        ['MessageDelivery', ['translationSourceId']], ['MessageDelivery', ['channelKey', 'sequence']],
      ] as const) await checkUnique(tx, table, names, false);
      for (const [table, from, target] of [
        ['TranslationSource', 'deliveryId', 'MessageDelivery'], ['ConversationTurn', 'deliveryId', 'MessageDelivery'],
        ['MessageDelivery', 'sessionId', 'Session'], ['DeliveryReceipt', 'deliveryId', 'MessageDelivery'],
        ['DeliveryAction', 'deliveryId', 'MessageDelivery'],
      ]) {
        const keys = await tx.$queryRawUnsafe<Array<{ table: string; from: string; to: string; on_delete: string; on_update: string }>>(`PRAGMA foreign_key_list(${quote(table)})`);
        if (!keys.some(key => key.table === target && key.from === from && key.to === 'id'
          && key.on_delete === 'CASCADE' && key.on_update === 'CASCADE')) incompatible(`${table}.${from} foreign key is missing or incompatible`);
      }
      await checkDeliveryReferences(tx);
    }, { maxWait: 1_000, timeout: 5_000 });
    // Full-database scans have data-size-dependent cost. Keep them outside the
    // short schema transaction, while still blocking all application recovery.
    await checkIntegrity(db);
    for (const initial of await db.messageDelivery.findMany({ where: { origin: 'TEAM_INITIAL' } })) {
      try { readTeamDeliveryIntent(initial); } catch { incompatible('Initial team creation intent is inconsistent'); }
    }
    // A reverse room link is itself a publication claim, regardless of origin.
    // A valid legacy runtime delivery must not hide a mislinked Agent message.
    const rooms = await db.messageDelivery.findMany({ where: { OR: [
      { roomMessage: { isNot: null } },
      { origin: { in: ['TEAM_USER','TEAM_INITIAL'] }, OR: [{ state: 'SENT' }, { receipt: { isNot: null } }] },
    ] } });
    for (const row of rooms) {
      try { await verifyPublishedTeamDelivery(db, row); } catch { incompatible('Team room publication facts are inconsistent'); }
    }
  });
}

function isSchemaRace(error: unknown): boolean {
  if (error instanceof CompatibilityError) return false;
  const e = error as { code?: string; message?: string; stderr?: string; stdout?: string };
  return e.code === 'P1008' || e.code === 'P2034'
    || /SQLITE_BUSY|\bP1008\b|database (?:is )?locked|database schema has changed|no such table: (?:new_ConversationTurn|new_TranslationSource|new_MessageDelivery|new_RoomMessage|new_TeamRun|new_WorkRequest|new_AgentInvocation)\b|duplicate column name: (?:creationFingerprint|creationSubmissionId|initialDeliveryId|inputIntent|deliveryId|originalText|deliveryRevision)\b|(?:table|index) ["']?(?:new_ConversationTurn|new_TranslationSource|new_MessageDelivery|new_RoomMessage|new_TeamRun|new_WorkRequest|new_AgentInvocation|MessageDelivery|TeamTaskInputSnapshot|TeamTaskInputAction|RoomMessage_deliveryId_key|DeliveryReceipt|DeliveryAction|Workspace_creationSubmissionId_key|Session_(?:creationSubmissionId|initialDeliveryId)_key|ConversationTurn_deliveryId_key|MessageDelivery_(?:clientSubmissionId_key|translationSourceId_key|channelKey_sequence_key|sessionId_sequence_idx|state_updatedAt_idx))["']? already exists/i.test(`${e.message}\n${e.stderr}\n${e.stdout}`);
}

async function schemaVersion(dbPath: string): Promise<number> {
  let version = 0;
  await withDatabase(dbPath, async db => {
    const rows = await db.$queryRawUnsafe<Array<{ schema_version: number | bigint }>>('PRAGMA schema_version');
    version = Number(rows[0].schema_version);
  });
  return version;
}

/** Both entries must complete this barrier before importing/building the app. */
export async function synchronizeDatabaseSchema(options: { dataDir: string; dbPath: string; schemaPath: string; entryDir: string }): Promise<void> {
  const prisma = getBundledPrismaCommand(options.entryDir);
  for (let attempt = 1; ; attempt++) {
    let stage = 'prepare';
    let versionBeforePush: number | undefined;
    try {
      await prepareP3Database(options.dbPath);
      versionBeforePush = await schemaVersion(options.dbPath);
      stage = 'push';
      // The preparation transaction and its connection have ended. Never hold
      // a database transaction while waiting for the external Prisma process.
      await execFileAsync(prisma.command, [...prisma.args, 'db', 'push', '--skip-generate', `--schema=${options.schemaPath}`], {
        env: preparePrismaCliEnv(options.dataDir, options.dbPath), timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      stage = 'verify';
      await verifyP3Database(options.dbPath);
      return;
    } catch (error) {
      let schemaChanged = false;
      if (attempt < 3 && stage === 'push' && versionBeforePush !== undefined) {
        try {
          schemaChanged = await schemaVersion(options.dbPath) !== versionBeforePush;
        } catch (readError) {
          schemaChanged = isSchemaRace(readError);
        }
      }
      // Concurrent engines can introspect across table reconstruction and emit
      // misleading unique/required-column warnings. Retry only with evidence
      // of schema change (or a recognized lock/DDL race), then revalidate; never
      // approve the warning or force a reset.
      if (attempt < 3 && (schemaChanged || isSchemaRace(error))) {
        await delay(attempt * 150);
        continue; // Reopen, reread committed structure, then rerun the same barrier.
      }
      const failure = error as { message?: string; stdout?: string; stderr?: string };
      throw Object.assign(new Error(`Database schema ${stage} failed (attempt ${attempt}/3): ${failure.message ?? String(error)}`, { cause: error }), {
        stdout: failure.stdout, stderr: failure.stderr,
      });
    }
  }
}
