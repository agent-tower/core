ALTER TABLE "Task" ADD COLUMN "parentTaskId" TEXT REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Task_parentTaskId_deletedAt_idx" ON "Task"("parentTaskId", "deletedAt");
