import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-database-maintenance-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let runStartupDataMigrations: typeof import('../database-maintenance.service.js').runStartupDataMigrations;
let currentVersion: number;

describe('runStartupDataMigrations', () => {
  beforeAll(async () => {
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`],
      {
        cwd: serverRoot,
        env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
        stdio: 'pipe',
      },
    );

    const utils = await import('../../utils/index.js');
    const maintenance = await import('../database-maintenance.service.js');
    prisma = utils.prisma;
    runStartupDataMigrations = maintenance.runStartupDataMigrations;
    currentVersion = maintenance.databaseMaintenanceTestUtils.CURRENT_DATA_MIGRATION_VERSION;
  });

  beforeEach(async () => {
    await prisma.executionProcess.deleteMany();
    await prisma.agentInvocation.deleteMany();
    await prisma.workRequest.deleteMany();
    await prisma.teamMember.deleteMany();
    await prisma.teamRun.deleteMany();
    await prisma.session.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
    await prisma.appSettings.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('moves oversized historical titles into descriptions without losing or duplicating content', async () => {
    const project = await prisma.project.create({
      data: { name: 'Migration project', repoPath: testDir },
    });
    const historicalTitle = `Incident summary\n${'full diagnostic output '.repeat(40)}`;
    const existingDescription = 'Existing follow-up notes';
    const [withoutDescription, alreadyCopied, withDescription] = await Promise.all([
      prisma.task.create({
        data: { projectId: project.id, title: historicalTitle },
      }),
      prisma.task.create({
        data: { projectId: project.id, title: historicalTitle, description: historicalTitle },
      }),
      prisma.task.create({
        data: { projectId: project.id, title: historicalTitle, description: existingDescription },
      }),
    ]);

    await runStartupDataMigrations();
    await runStartupDataMigrations();

    const migrated = await prisma.task.findMany({
      where: { id: { in: [withoutDescription.id, alreadyCopied.id, withDescription.id] } },
      orderBy: { id: 'asc' },
    });
    expect(migrated).toHaveLength(3);
    expect(migrated.every((task) => task.title.length <= 200)).toBe(true);
    expect(migrated.every((task) => !task.title.includes('\n'))).toBe(true);
    expect(migrated.find((task) => task.id === withoutDescription.id)?.description).toBe(historicalTitle);
    expect(migrated.find((task) => task.id === alreadyCopied.id)?.description).toBe(historicalTitle);
    expect(migrated.find((task) => task.id === withDescription.id)?.description).toBe(
      `${historicalTitle}\n\n${existingDescription}`,
    );

    await expect(prisma.task.count({ where: { title: { contains: historicalTitle } } })).resolves.toBe(0);
    await expect(prisma.appSettings.findUnique({ where: { id: 'singleton' } })).resolves.toMatchObject({
      dataMigrationVersion: currentVersion,
    });
  });

  it('backfills runtime launch evidence conservatively and idempotently after db push', async () => {
    const project = await prisma.project.create({
      data: { name: 'Runtime migration project', repoPath: testDir },
    });
    const task = await prisma.task.create({
      data: { projectId: project.id, title: 'Runtime migration task' },
    });
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'runtime-migration',
        worktreePath: testDir,
        status: 'ACTIVE',
      },
    });
    const [neverStarted, unknownStarted, processRecorded] = await Promise.all([
      prisma.session.create({
        data: {
          workspaceId: workspace.id,
          agentType: 'CODEX',
          prompt: 'never started',
          status: 'PENDING',
        },
      }),
      prisma.session.create({
        data: {
          workspaceId: workspace.id,
          agentType: 'CODEX',
          prompt: 'unknown started runtime',
          status: 'RUNNING',
        },
      }),
      prisma.session.create({
        data: {
          workspaceId: workspace.id,
          agentType: 'CODEX',
          prompt: 'persisted process evidence',
          status: 'COMPLETED',
        },
      }),
    ]);
    const legacyProcess = await prisma.executionProcess.create({
      data: {
        sessionId: processRecorded.id,
        runtimeInstanceId: null,
        pid: 9501,
        processGroupId: null,
        birthMarker: null,
        ownershipToken: null,
        cleanupState: 'ACTIVE',
      },
    });
    await prisma.appSettings.create({
      data: { id: 'singleton', dataMigrationVersion: 1 },
    });

    await runStartupDataMigrations();
    await runStartupDataMigrations();

    await expect(prisma.session.findUnique({ where: { id: neverStarted.id } })).resolves.toMatchObject({
      runtimeLaunchState: 'NOT_STARTED',
      runtimeLaunchClaimCount: 0,
      runtimeLaunchResolvedCount: 0,
      runtimeLaunchProcessCount: 0,
    });
    await expect(prisma.session.findUnique({ where: { id: unknownStarted.id } })).resolves.toMatchObject({
      runtimeLaunchState: 'QUARANTINED',
      runtimeLaunchClaimCount: 1,
      runtimeLaunchResolvedCount: 0,
      runtimeLaunchProcessCount: 0,
      runtimeLaunchDiagnostic: 'Legacy session crossed logical start without durable process evidence',
      runtimeLaunchDiagnosticCount: 1,
      runtimeLaunchNextDiagnosticAt: expect.any(Date),
    });
    await expect(prisma.session.findUnique({ where: { id: processRecorded.id } })).resolves.toMatchObject({
      runtimeLaunchState: 'PROCESS_RECORDED',
      runtimeLaunchClaimCount: 1,
      runtimeLaunchResolvedCount: 1,
      runtimeLaunchProcessCount: 1,
    });
    await expect(prisma.executionProcess.findUnique({ where: { id: legacyProcess.id } })).resolves.toMatchObject({
      launchClaimNumber: null,
      runtimeInstanceId: null,
      cleanupState: 'QUARANTINED',
      cleanupError: expect.stringContaining('identity is incomplete'),
      cleanupAttemptCount: 1,
      nextCleanupRetryAt: expect.any(Date),
    });
    await expect(prisma.appSettings.findUnique({ where: { id: 'singleton' } })).resolves.toMatchObject({
      dataMigrationVersion: currentVersion,
    });
  });
});
