-- CreateTable
CREATE TABLE "WorkspaceVerdict" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "teamRunId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "verdict" TEXT NOT NULL,
  "reviewedSha" TEXT NOT NULL,
  "reviewerMemberId" TEXT,
  "reason" TEXT,
  "sequence" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceVerdict_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkspaceVerdict_teamRunId_fkey" FOREIGN KEY ("teamRunId") REFERENCES "TeamRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "WorkspaceVerdict_workspaceId_kind_createdAt_idx" ON "WorkspaceVerdict"("workspaceId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "WorkspaceVerdict_workspaceId_kind_sequence_idx" ON "WorkspaceVerdict"("workspaceId", "kind", "sequence");

-- CreateIndex
CREATE INDEX "WorkspaceVerdict_teamRunId_idx" ON "WorkspaceVerdict"("teamRunId");

-- CreateIndex
CREATE INDEX "WorkspaceVerdict_reviewerMemberId_idx" ON "WorkspaceVerdict"("reviewerMemberId");
