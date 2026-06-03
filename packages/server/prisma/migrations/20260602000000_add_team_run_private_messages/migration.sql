-- AlterTable
ALTER TABLE "RoomMessage" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'PUBLIC';

-- CreateTable
CREATE TABLE "RoomMessageParticipant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamRunId" TEXT NOT NULL,
    "roomMessageId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoomMessageParticipant_roomMessageId_fkey" FOREIGN KEY ("roomMessageId") REFERENCES "RoomMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RoomMessageParticipant_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "TeamMember" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RoomMessage_teamRunId_visibility_idx" ON "RoomMessage"("teamRunId", "visibility");

-- CreateIndex
CREATE UNIQUE INDEX "RoomMessageParticipant_roomMessageId_memberId_key" ON "RoomMessageParticipant"("roomMessageId", "memberId");

-- CreateIndex
CREATE INDEX "RoomMessageParticipant_teamRunId_memberId_idx" ON "RoomMessageParticipant"("teamRunId", "memberId");

-- CreateIndex
CREATE INDEX "RoomMessageParticipant_roomMessageId_idx" ON "RoomMessageParticipant"("roomMessageId");

-- CreateIndex
CREATE INDEX "RoomMessageParticipant_memberId_idx" ON "RoomMessageParticipant"("memberId");
