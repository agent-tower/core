-- AlterTable
ALTER TABLE "WorkRequest" ADD COLUMN "startAttemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkRequest" ADD COLUMN "lastStartError" TEXT;
ALTER TABLE "WorkRequest" ADD COLUMN "nextStartRetryAt" DATETIME;

-- CreateIndex
CREATE INDEX "WorkRequest_status_nextStartRetryAt_idx" ON "WorkRequest"("status", "nextStartRetryAt");
