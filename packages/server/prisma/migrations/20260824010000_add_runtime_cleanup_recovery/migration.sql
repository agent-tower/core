-- Persist stop admission and retryable process ownership without rewriting the
-- preceding ownership migration, which may already be applied.
ALTER TABLE "ExecutionProcess" ADD COLUMN "ownershipToken" TEXT;
ALTER TABLE "ExecutionProcess" ADD COLUMN "cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ExecutionProcess" ADD COLUMN "nextCleanupRetryAt" DATETIME;

ALTER TABLE "AgentInvocation" ADD COLUMN "dispatchRevokedAt" DATETIME;

CREATE INDEX "ExecutionProcess_cleanupState_nextCleanupRetryAt_idx"
ON "ExecutionProcess"("cleanupState", "nextCleanupRetryAt");
