// Frozen pre-P3 schema: 563d004f2d586625dbb96e36fe4f638a45e634ce.
// Uses only the target installation's Prisma; no source-tree module resolution.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function fixtureClient(installedRoot, dbPath) {
  const { PrismaClient } = createRequire(path.join(installedRoot, 'package.json'))('@prisma/client');
  return new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
}

export async function seedLegacyDatabase(installedRoot, dbPath, scratchDir, nodeExecutable = process.execPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const home = path.join(scratchDir, 'seed-home');
  mkdirSync(home, { recursive: true });
  execFileSync(nodeExecutable, [path.join(installedRoot, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate',
    `--schema=${fileURLToPath(new URL('./fixtures/p3-legacy.prisma', import.meta.url))}`], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CACHE_DIR: path.join(home, 'cache'), AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
    stdio: 'pipe', timeout: 30_000,
  });
  const db = fixtureClient(installedRoot, dbPath);
  const timestamp = 1740000123456;
  const insert = async (table, values) => {
    const names = Object.keys(values);
    await db.$executeRawUnsafe(`INSERT INTO "${table}" (${names.map(name => `"${name}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`, ...Object.values(values));
  };
  try {
    await insert('Project', { id: 'project', name: 'Legacy', repoPath: scratchDir, createdAt: timestamp, updatedAt: timestamp });
    await insert('Task', { id: 'task', projectId: 'project', title: 'Legacy task', description: '  body\n\n  ', status: 'DONE', createdAt: timestamp, updatedAt: timestamp });
    await insert('AppSettings', { id: 'singleton', dataMigrationVersion: 2 });
    for (let i = 0; i < 2; i++) {
      await insert('Workspace', { id: `workspace-${i}`, taskId: 'task', branchName: `legacy-${i}`, worktreePath: scratchDir, workingDir: scratchDir, status: 'ABANDONED', createdAt: timestamp, updatedAt: timestamp });
      await insert('Conversation', { id: `conversation-${i}`, title: 'Legacy conversation', directoryName: `legacy-${i}`, workingDir: scratchDir, createdAt: timestamp, updatedAt: timestamp });
      for (const context of ['WORKSPACE', 'CONVERSATION']) {
        const id = `session-${context}-${i}`;
        await insert('Session', { id, workspaceId: context === 'WORKSPACE' ? `workspace-${i}` : null, conversationId: context === 'CONVERSATION' ? `conversation-${i}` : null,
          context, agentType: 'CODEX', prompt: ' \nExact\t正文  \n', status: 'COMPLETED', createdAt: timestamp, updatedAt: timestamp });
        if (context === 'CONVERSATION') await insert('ConversationTurn', { id: `turn-${i}`, sessionId: id, message: '  preserve\n\n空白\t ', status: 'COMPLETED', attempts: 3, lastError: 'prior failure', queuedAt: timestamp - 20, startedAt: timestamp - 10, completedAt: timestamp, createdAt: timestamp - 20, updatedAt: timestamp });
        const sourceId = `source-${context}-${i}`;
        await insert('TranslationSource', { id: sourceId, scopeType: 'SESSION', scopeId: id, sourceKind: 'SESSION_BLOCK', sourceKey: id, laneKey: id, sessionId: id, direction: 'DISPLAY',
          originalText: '\n  original 正文\t\n ', sourceHash: `hash-${id}`, sourceRevision: 2, blockState: 'SEALED', jobState: 'SUCCESS', currentAttemptVersion: 2,
          effectiveAttemptId: `attempt-${sourceId}-2`, generation: 4, retryCount: 2, retryChainId: 'old-chain', budgetStartedAt: timestamp - 50, createdAt: timestamp - 100, updatedAt: timestamp });
        for (let version = 1; version <= 2; version++) await insert('TranslationAttempt', { id: `attempt-${sourceId}-${version}`, sourceId, sourceRevision: 2, sourceHash: `hash-${id}`, attemptVersion: version,
          configRevision: 3, credentialRevision: 2, targetLanguage: 'English', sanitizedConfigSnapshot: '{}', protectionVersion: 'v1', status: version === 1 ? 'FAILED' : 'SUCCESS', resultText: version === 1 ? null : ' \n translated\t ',
          errorCode: version === 1 ? 'HTTP_503' : null, generation: 4, enableEpoch: 1, retryIndex: version - 1, startedAt: timestamp - 20, completedAt: timestamp });
      }
    }
    return await snapshotLegacyDatabase(db);
  } finally { await db.$disconnect(); }
}

export async function snapshotLegacyDatabase(db, baseline) {
  const result = {};
  for (const table of ['Project', 'Task', 'Workspace', 'Conversation', 'Session', 'ConversationTurn', 'TranslationSource', 'TranslationAttempt', 'AppSettings']) {
    const names = baseline ? baseline[table].columns : (await db.$queryRawUnsafe(`PRAGMA table_info("${table}")`)).map(row => row.name);
    // Cast dates/booleans to strings to compare exact stored values, independent
    // of Prisma's generated model and the presence of P3's new columns.
    const rows = await db.$queryRawUnsafe(`SELECT ${names.map(name => `CAST("${name}" AS TEXT) AS "${name}"`).join(',')} FROM "${table}" ORDER BY id`);
    result[table] = { columns: names, rows };
  }
  return result;
}

export async function assertLegacyDatabase(installedRoot, dbPath, baseline) {
  const db = fixtureClient(installedRoot, dbPath);
  try {
    const snapshot = await snapshotLegacyDatabase(db, baseline);
    if (JSON.stringify(snapshot) !== JSON.stringify(baseline)) throw new Error('Legacy column values changed during startup');
    const foreignKeys = await db.$queryRawUnsafe('PRAGMA foreign_key_check');
    const integrity = await db.$queryRawUnsafe('PRAGMA integrity_check');
    if (foreignKeys.length || integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Legacy DB FK/integrity check failed');
    return 'legacy=preserved sessions=4 turns=2 sources=4 attempts=8 fk=ok integrity=ok';
  } finally { await db.$disconnect(); }
}
