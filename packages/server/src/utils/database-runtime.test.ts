import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-database-runtime-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

let prisma: PrismaClient;
let initializeDatabaseRuntime: typeof import('./index.js').initializeDatabaseRuntime;
let busyTimeoutMs: number;

describe('initializeDatabaseRuntime', () => {
  beforeAll(async () => {
    const utils = await import('./index.js');
    prisma = utils.prisma;
    initializeDatabaseRuntime = utils.initializeDatabaseRuntime;
    busyTimeoutMs = utils.SQLITE_BUSY_TIMEOUT_MS;
  });

  afterAll(async () => {
    await prisma.$disconnect();
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
});
