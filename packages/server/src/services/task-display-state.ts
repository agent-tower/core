import prismaPkg from '@prisma/client';
import { TaskStatus, type TaskDisplayState } from '@agent-tower/shared';

const { Prisma } = prismaPkg;

// Correlated to the outer `task` row. The supported hierarchy has three levels;
// use the parentTaskId index, including children outside the requested page.
// Keep project/status checks in the projection: putting them in WHERE makes
// SQLite prefer the project/status index and scan the project for every task.
function descendantCount(status: TaskStatus) {
  return Prisma.sql`(
    SELECT COALESCE(SUM(CASE
      WHEN descendant."projectId" = task."projectId" AND descendant."status" = ${status} THEN 1
      ELSE 0
    END), 0) FROM "Task" descendant
    WHERE descendant."deletedAt" IS NULL
      AND descendant."parentTaskId" IN (
        SELECT task."id"
        UNION ALL
        SELECT CASE WHEN child."projectId" = task."projectId" THEN child."id" END FROM "Task" child
        WHERE child."parentTaskId" = task."id"
          AND child."deletedAt" IS NULL
      )
  )`;
}

const runningDescendantCount = descendantCount(TaskStatus.IN_PROGRESS);
const reviewDescendantCount = descendantCount(TaskStatus.IN_REVIEW);

// Keep the persisted status for writes and runtime lifecycle decisions.
// Reads, filters and statistics share this display-only expression.
export const taskDisplayStatusSql = Prisma.sql`CASE
  WHEN task."status" = ${TaskStatus.IN_PROGRESS} OR ${runningDescendantCount} > 0 THEN ${TaskStatus.IN_PROGRESS}
  WHEN task."status" = ${TaskStatus.IN_REVIEW} OR ${reviewDescendantCount} > 0 THEN ${TaskStatus.IN_REVIEW}
  ELSE task."status"
END`;

export const taskDisplayColumnsSql = Prisma.sql`
  ${taskDisplayStatusSql} AS "displayStatus",
  ${runningDescendantCount} AS "runningDescendantCount",
  ${reviewDescendantCount} AS "reviewDescendantCount"
`;

export interface TaskDisplayRow {
  displayStatus: TaskStatus;
  runningDescendantCount: bigint | number;
  reviewDescendantCount: bigint | number;
}

export function mapTaskDisplayState(row: TaskDisplayRow): Required<TaskDisplayState> {
  return {
    displayStatus: row.displayStatus,
    runningDescendantCount: Number(row.runningDescendantCount),
    reviewDescendantCount: Number(row.reviewDescendantCount),
  };
}
