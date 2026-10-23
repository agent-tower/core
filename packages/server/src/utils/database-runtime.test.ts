import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pkg, { type PrismaClient } from '@prisma/client';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-database-runtime-'));
const originalDatabaseUrl = process.env.AGENT_TOWER_DATABASE_URL;

let prisma: PrismaClient;
let initializeDatabaseRuntime: typeof import('./index.js').initializeDatabaseRuntime;
let busyTimeoutMs: number;
let dbPath: string;
let databaseNumber = 0;

describe('initializeDatabaseRuntime', () => {
  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(testDir, `test-${++databaseNumber}.db`);
    process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
    const utils = await import('./index.js');
    prisma = utils.prisma;
    initializeDatabaseRuntime = utils.initializeDatabaseRuntime;
    busyTimeoutMs = utils.SQLITE_BUSY_TIMEOUT_MS;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.$disconnect();
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) delete process.env.AGENT_TOWER_DATABASE_URL;
    else process.env.AGENT_TOWER_DATABASE_URL = originalDatabaseUrl;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('enables WAL and configures the SQLite busy timeout', async () => {
    await initializeDatabaseRuntime();

    const journalMode = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>(
      'PRAGMA journal_mode',
    );
    const busyTimeout = await prisma.$queryRawUnsafe<Array<{ timeout: bigint | number }>>(
      'PRAGMA busy_timeout',
    );

    expect(journalMode[0]?.journal_mode.toLowerCase()).toBe('wal');
    expect(Number(busyTimeout[0]?.timeout)).toBe(busyTimeoutMs);
  });

  it('waits for an existing SQLite writer before enabling WAL', async () => {
    const writer = new pkg.PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
    let locked = false;
    let initialization: Promise<void> | undefined;
    try {
      await writer.$executeRawUnsafe('CREATE TABLE StartupEvidence (value TEXT)');
      await writer.$executeRawUnsafe('BEGIN EXCLUSIVE');
      locked = true;
      await writer.$executeRawUnsafe("INSERT INTO StartupEvidence VALUES ('preserved')");
      let initialized = false;
      initialization = initializeDatabaseRuntime().then(() => { initialized = true; });
      // Attach a handler immediately so the pre-fix rejection is reported by
      // this assertion, rather than as an unhandled promise rejection.
      void initialization.catch(() => {});
      await delay(100);
      expect(initialized).toBe(false);
      await writer.$executeRawUnsafe('COMMIT');
      locked = false;
      await initialization;
      expect(await prisma.$queryRawUnsafe('SELECT value FROM StartupEvidence'))
        .toEqual([{ value: 'preserved' }]);
      expect(await prisma.$queryRawUnsafe('PRAGMA journal_mode')).toEqual([{ journal_mode: 'wal' }]);
    } finally {
      if (locked) await writer.$executeRawUnsafe('ROLLBACK');
      await initialization?.catch(() => {});
      await writer.$disconnect();
    }
  });

  it('shares initialization and retries a transient WAL lock after configuring busy_timeout', async () => {
    const lock = { code: 'P2010', meta: { code: '5' }, message: 'database is locked' };
    const query = vi.spyOn(prisma, '$queryRawUnsafe')
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(lock)
      .mockResolvedValueOnce([{ journal_mode: 'wal' }]);

    const initialization = initializeDatabaseRuntime();
    expect(initializeDatabaseRuntime()).toBe(initialization);
    await initialization;
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      `PRAGMA busy_timeout = ${busyTimeoutMs}`, 'PRAGMA journal_mode = WAL', 'PRAGMA journal_mode = WAL',
    ]);
  });

  it('stops retrying locks after the startup window and preserves the original failure', async () => {
    const lock = { code: 'P2010', meta: { code: '5' }, message: 'database is locked' };
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(50)
      .mockReturnValue(busyTimeoutMs + 1);
    const query = vi.spyOn(prisma, '$queryRawUnsafe')
      .mockResolvedValueOnce([])
      .mockRejectedValue(lock);

    await expect(initializeDatabaseRuntime()).rejects.toBe(lock);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('does not retry permanent query errors and allows initialization after a failure', async () => {
    const failure = { code: 'P2010', meta: { code: '11' }, message: 'database disk image is malformed' };
    const query = vi.spyOn(prisma, '$queryRawUnsafe')
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(failure);

    await expect(initializeDatabaseRuntime()).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(2);
    query.mockResolvedValue([]);
    await initializeDatabaseRuntime();
    expect(query).toHaveBeenCalledTimes(4);
  });
});
