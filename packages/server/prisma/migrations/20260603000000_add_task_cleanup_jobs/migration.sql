ALTER TABLE "Task" ADD COLUMN "deletedAt" DATETIME;

CREATE TABLE "TaskCleanupJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextRetryAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "Task_deletedAt_idx" ON "Task"("deletedAt");
CREATE INDEX "TaskCleanupJob_taskId_idx" ON "TaskCleanupJob"("taskId");
CREATE INDEX "TaskCleanupJob_status_nextRetryAt_idx" ON "TaskCleanupJob"("status", "nextRetryAt");
CREATE INDEX "TaskCleanupJob_projectId_idx" ON "TaskCleanupJob"("projectId");
