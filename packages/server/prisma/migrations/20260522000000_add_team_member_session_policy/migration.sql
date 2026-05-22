ALTER TABLE "MemberPreset" ADD COLUMN "sessionPolicy" TEXT NOT NULL DEFAULT 'new_per_request';
ALTER TABLE "TeamMember" ADD COLUMN "sessionPolicy" TEXT NOT NULL DEFAULT 'new_per_request';
