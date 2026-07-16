import { prisma } from '../utils/index.js';

const APP_SETTINGS_ID = 'singleton';
const CURRENT_DATA_MIGRATION_VERSION = 1;

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

    await tx.appSettings.update({
      where: { id: APP_SETTINGS_ID },
      data: { dataMigrationVersion: CURRENT_DATA_MIGRATION_VERSION },
    });
  });
}

export const databaseMaintenanceTestUtils = {
  CURRENT_DATA_MIGRATION_VERSION,
};
