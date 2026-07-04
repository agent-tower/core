-- AlterTable
ALTER TABLE "WorkRequest" ADD COLUMN "targetKind" TEXT;
ALTER TABLE "WorkRequest" ADD COLUMN "targetPurpose" TEXT;
ALTER TABLE "WorkRequest" ADD COLUMN "targetSourceWorkspaceId" TEXT;
ALTER TABLE "WorkRequest" ADD COLUMN "targetSourceMemberId" TEXT;
ALTER TABLE "WorkRequest" ADD COLUMN "targetHeadSha" TEXT;
ALTER TABLE "WorkRequest" ADD COLUMN "targetBranchName" TEXT;
ALTER TABLE "WorkRequest" ADD COLUMN "targetPlanItemId" TEXT;

-- AlterTable
ALTER TABLE "AgentInvocation" ADD COLUMN "targetKind" TEXT;
ALTER TABLE "AgentInvocation" ADD COLUMN "targetPurpose" TEXT;
ALTER TABLE "AgentInvocation" ADD COLUMN "targetSourceWorkspaceId" TEXT;
ALTER TABLE "AgentInvocation" ADD COLUMN "targetSourceMemberId" TEXT;
ALTER TABLE "AgentInvocation" ADD COLUMN "targetHeadSha" TEXT;
ALTER TABLE "AgentInvocation" ADD COLUMN "targetBranchName" TEXT;
ALTER TABLE "AgentInvocation" ADD COLUMN "targetPlanItemId" TEXT;
ALTER TABLE "AgentInvocation" ADD COLUMN "targetSyncStatus" TEXT;
ALTER TABLE "AgentInvocation" ADD COLUMN "targetSyncError" TEXT;
ALTER TABLE "AgentInvocation" ADD COLUMN "targetExecutionBranch" TEXT;
ALTER TABLE "AgentInvocation" ADD COLUMN "targetPort" INTEGER;
ALTER TABLE "AgentInvocation" ADD COLUMN "targetVitePort" INTEGER;
ALTER TABLE "AgentInvocation" ADD COLUMN "targetE2EPort" INTEGER;

-- CreateIndex
CREATE INDEX "WorkRequest_targetSourceWorkspaceId_idx" ON "WorkRequest"("targetSourceWorkspaceId");

-- CreateIndex
CREATE INDEX "WorkRequest_targetHeadSha_idx" ON "WorkRequest"("targetHeadSha");

-- CreateIndex
CREATE INDEX "AgentInvocation_targetSourceWorkspaceId_idx" ON "AgentInvocation"("targetSourceWorkspaceId");

-- CreateIndex
CREATE INDEX "AgentInvocation_targetHeadSha_idx" ON "AgentInvocation"("targetHeadSha");

-- CreateIndex
CREATE INDEX "AgentInvocation_targetSyncStatus_idx" ON "AgentInvocation"("targetSyncStatus");
