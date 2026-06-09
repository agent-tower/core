ALTER TABLE "Workspace" ADD COLUMN "workspaceKind" TEXT NOT NULL DEFAULT 'WORKTREE';
ALTER TABLE "Workspace" ADD COLUMN "workingDir" TEXT NOT NULL DEFAULT '';

UPDATE "Workspace" SET "workingDir" = "worktreePath" WHERE "workingDir" = '';

CREATE INDEX "Workspace_workspaceKind_idx" ON "Workspace"("workspaceKind");
CREATE INDEX "Workspace_workingDir_idx" ON "Workspace"("workingDir");
