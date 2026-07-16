ALTER TABLE "Project" ADD COLUMN "isGitRepo" BOOLEAN;
ALTER TABLE "Project" ADD COLUMN "worktreeReady" BOOLEAN;
ALTER TABLE "Project" ADD COLUMN "gitCapabilityReason" TEXT;
ALTER TABLE "Project" ADD COLUMN "gitCapabilityCheckedAt" DATETIME;
