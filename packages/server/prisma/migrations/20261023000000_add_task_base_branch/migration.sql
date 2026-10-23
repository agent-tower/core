-- Existing tasks retain their workspace base branches and project fallback.
ALTER TABLE "Task" ADD COLUMN "baseBranch" TEXT;
