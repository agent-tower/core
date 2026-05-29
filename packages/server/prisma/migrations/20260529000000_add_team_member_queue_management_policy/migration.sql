ALTER TABLE "MemberPreset" ADD COLUMN "queueManagementPolicy" TEXT NOT NULL DEFAULT 'own_only';
ALTER TABLE "TeamMember" ADD COLUMN "queueManagementPolicy" TEXT NOT NULL DEFAULT 'own_only';
