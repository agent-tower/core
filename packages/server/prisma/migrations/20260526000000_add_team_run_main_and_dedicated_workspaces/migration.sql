-- AlterTable
ALTER TABLE "TeamRun" ADD COLUMN "mainWorkspaceId" TEXT REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "parentWorkspaceId" TEXT REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Workspace" ADD COLUMN "ownerMemberId" TEXT REFERENCES "TeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "TeamRun_mainWorkspaceId_idx" ON "TeamRun"("mainWorkspaceId");

-- CreateIndex
CREATE INDEX "Workspace_parentWorkspaceId_idx" ON "Workspace"("parentWorkspaceId");

-- CreateIndex
CREATE INDEX "Workspace_ownerMemberId_idx" ON "Workspace"("ownerMemberId");

-- CreateIndex
CREATE INDEX "Workspace_taskId_parentWorkspaceId_idx" ON "Workspace"("taskId", "parentWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_parentWorkspaceId_ownerMemberId_key" ON "Workspace"("parentWorkspaceId", "ownerMemberId");
