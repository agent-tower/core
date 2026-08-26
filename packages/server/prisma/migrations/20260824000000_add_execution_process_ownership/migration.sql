-- Track the runtime generation and owned process-tree identity separately
-- from logical Session status so cleanup can be retried after a crash.
ALTER TABLE "ExecutionProcess" ADD COLUMN "runtimeInstanceId" TEXT;
ALTER TABLE "ExecutionProcess" ADD COLUMN "processGroupId" TEXT;
ALTER TABLE "ExecutionProcess" ADD COLUMN "birthMarker" TEXT;
ALTER TABLE "ExecutionProcess" ADD COLUMN "cleanupState" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "ExecutionProcess" ADD COLUMN "cleanupError" TEXT;

CREATE INDEX "ExecutionProcess_runtimeInstanceId_idx" ON "ExecutionProcess"("runtimeInstanceId");
CREATE INDEX "ExecutionProcess_cleanupState_idx" ON "ExecutionProcess"("cleanupState");
