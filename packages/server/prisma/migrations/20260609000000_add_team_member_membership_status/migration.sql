ALTER TABLE "TeamMember" ADD COLUMN "membershipStatus" TEXT NOT NULL DEFAULT 'ACTIVE';

CREATE INDEX "TeamMember_teamRunId_membershipStatus_idx" ON "TeamMember"("teamRunId", "membershipStatus");
