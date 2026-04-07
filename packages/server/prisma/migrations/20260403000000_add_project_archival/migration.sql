-- AlterTable
ALTER TABLE "Project" ADD COLUMN "repoRemoteUrl" TEXT;
ALTER TABLE "Project" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "Project" ADD COLUMN "repoDeletedAt" DATETIME;

-- CreateIndex
CREATE INDEX "Project_archivedAt_idx" ON "Project"("archivedAt");

-- CreateIndex
CREATE INDEX "Project_repoDeletedAt_idx" ON "Project"("repoDeletedAt");
