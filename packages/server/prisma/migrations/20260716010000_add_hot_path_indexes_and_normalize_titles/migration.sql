ALTER TABLE "AppSettings" ADD COLUMN "dataMigrationVersion" INTEGER NOT NULL DEFAULT 0;

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
WHERE length("title") > 240;

INSERT INTO "AppSettings" ("id", "dataMigrationVersion")
VALUES ('singleton', 1)
ON CONFLICT("id") DO UPDATE SET "dataMigrationVersion" = MAX("dataMigrationVersion", 1);

CREATE INDEX "Task_projectId_deletedAt_status_position_idx"
ON "Task"("projectId", "deletedAt", "status", "position");

CREATE INDEX "Task_deletedAt_updatedAt_idx"
ON "Task"("deletedAt", "updatedAt");

CREATE INDEX "Session_workspaceId_purpose_createdAt_idx"
ON "Session"("workspaceId", "purpose", "createdAt");
