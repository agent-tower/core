-- Persist launch admission independently from logical Session status. Every
-- possible process launch increments claimCount before spawn; only a durable
-- process row, transport reuse, or proven pre-child failure resolves it.
ALTER TABLE "Session" ADD COLUMN "runtimeLaunchState" TEXT NOT NULL DEFAULT 'NOT_STARTED';
ALTER TABLE "Session" ADD COLUMN "runtimeLaunchClaimCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Session" ADD COLUMN "runtimeLaunchResolvedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Session" ADD COLUMN "runtimeLaunchProcessCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Session" ADD COLUMN "runtimeLaunchDiagnostic" TEXT;
ALTER TABLE "Session" ADD COLUMN "runtimeLaunchDiagnosticCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Session" ADD COLUMN "runtimeLaunchNextDiagnosticAt" DATETIME;

ALTER TABLE "ExecutionProcess" ADD COLUMN "launchClaimNumber" INTEGER;

CREATE UNIQUE INDEX "ExecutionProcess_sessionId_launchClaimNumber_key"
ON "ExecutionProcess"("sessionId", "launchClaimNumber");

-- Historical ownership that cannot be tied to a complete process generation
-- is never signal-safe. Persist quarantine immediately; heartbeat/startup
-- recovery will emit bounded recurring diagnostics without touching the PID.
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
  );

-- Existing process rows are durable evidence that a launch crossed admission.
-- Their nullable claim number remains a legacy marker and is handled
-- conservatively by the cleanup gate when ownership identity is incomplete.
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
);

-- PENDING + no process is the only legacy state that proves the initial
-- PENDING -> RUNNING launch barrier was never crossed. All other empty legacy
-- sessions remain quarantined rather than being guessed safe.
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
  );

INSERT INTO "AppSettings" ("id", "dataMigrationVersion")
VALUES ('singleton', 2)
ON CONFLICT("id") DO UPDATE SET "dataMigrationVersion" = MAX("dataMigrationVersion", 2);
