ALTER TABLE "Workspace" ADD COLUMN "cleanedAt" DATETIME;
CREATE INDEX "Workspace_status_cleanedAt_idx" ON "Workspace"("status", "cleanedAt");
