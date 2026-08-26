import { prisma } from '../utils/index.js';

const APP_SETTINGS_ID = 'singleton';
const CURRENT_DATA_MIGRATION_VERSION = 2;

export async function runStartupDataMigrations(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const settings = await tx.appSettings.upsert({
      where: { id: APP_SETTINGS_ID },
      create: { id: APP_SETTINGS_ID },
      update: {},
      select: { dataMigrationVersion: true },
    });
    if (settings.dataMigrationVersion >= CURRENT_DATA_MIGRATION_VERSION) {
      return;
    }

    if (settings.dataMigrationVersion < 1) {
      // Historical clients could put pasted logs into Task.title. Preserve the exact
      // body in description before shrinking the list-facing title.
      await tx.$executeRawUnsafe(`
        UPDATE "Task"
        SET
          "description" = CASE
            WHEN "description" IS NULL OR trim("description") = '' THEN "title"
            WHEN instr("description", "title") > 0 THEN "description"
            ELSE "title" || char(10) || char(10) || "description"
          END,
          "title" = CASE
            WHEN length(trim("title")) = 0 THEN 'Untitled task'
            ELSE rtrim(substr(replace(replace(trim("title"), char(13), ' '), char(10), ' '), 1, 197)) || '...'
          END
        WHERE length("title") > 240
      `);
    }

    if (settings.dataMigrationVersion < 2) {
      await tx.$executeRawUnsafe(`
        UPDATE "ExecutionProcess"
        SET
          "cleanupState" = 'QUARANTINED',
          "cleanupError" = 'Runtime ownership identity is incomplete; automated signalling and cleanup confirmation are disabled',
          "cleanupAttemptCount" = "cleanupAttemptCount" + 1,
          "nextCleanupRetryAt" = CURRENT_TIMESTAMP
        WHERE "cleanupState" <> 'CONFIRMED'
          AND (
            "runtimeInstanceId" IS NULL
            OR "pid" IS NULL
            OR "processGroupId" IS NULL
            OR "birthMarker" IS NULL
            OR "ownershipToken" IS NULL
          )
      `);
      await tx.$executeRawUnsafe(`
        UPDATE "Session"
        SET
          "runtimeLaunchState" = 'PROCESS_RECORDED',
          "runtimeLaunchClaimCount" = (
            SELECT COUNT(*) FROM "ExecutionProcess" ep WHERE ep."sessionId" = "Session"."id"
          ),
          "runtimeLaunchResolvedCount" = (
            SELECT COUNT(*) FROM "ExecutionProcess" ep WHERE ep."sessionId" = "Session"."id"
          ),
          "runtimeLaunchProcessCount" = (
            SELECT COUNT(*) FROM "ExecutionProcess" ep WHERE ep."sessionId" = "Session"."id"
          )
        WHERE EXISTS (
          SELECT 1 FROM "ExecutionProcess" ep WHERE ep."sessionId" = "Session"."id"
        )
      `);
      await tx.$executeRawUnsafe(`
        UPDATE "Session"
        SET
          "runtimeLaunchState" = 'QUARANTINED',
          "runtimeLaunchClaimCount" = 1,
          "runtimeLaunchResolvedCount" = 0,
          "runtimeLaunchDiagnostic" = 'Legacy session crossed logical start without durable process evidence',
          "runtimeLaunchDiagnosticCount" = 1,
          "runtimeLaunchNextDiagnosticAt" = CURRENT_TIMESTAMP
        WHERE "status" <> 'PENDING'
          AND NOT EXISTS (
            SELECT 1 FROM "ExecutionProcess" ep WHERE ep."sessionId" = "Session"."id"
          )
      `);
    }

    await tx.appSettings.update({
      where: { id: APP_SETTINGS_ID },
      data: { dataMigrationVersion: CURRENT_DATA_MIGRATION_VERSION },
    });
  });
}

export const databaseMaintenanceTestUtils = {
  CURRENT_DATA_MIGRATION_VERSION,
};
