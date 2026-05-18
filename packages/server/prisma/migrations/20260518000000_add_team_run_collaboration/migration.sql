-- CreateTable
CREATE TABLE "MemberPreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "aliases" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "rolePrompt" TEXT NOT NULL,
    "capabilities" TEXT NOT NULL,
    "workspacePolicy" TEXT NOT NULL,
    "triggerPolicy" TEXT NOT NULL,
    "avatar" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TeamTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TeamTemplateMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamTemplateId" TEXT NOT NULL,
    "memberPresetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "TeamTemplateMember_teamTemplateId_fkey" FOREIGN KEY ("teamTemplateId") REFERENCES "TeamTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "reviewReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TeamRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamRunId" TEXT NOT NULL,
    "presetId" TEXT,
    "name" TEXT NOT NULL,
    "aliases" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "rolePrompt" TEXT NOT NULL,
    "capabilities" TEXT NOT NULL,
    "workspacePolicy" TEXT NOT NULL,
    "triggerPolicy" TEXT NOT NULL,
    "avatar" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TeamMember_teamRunId_fkey" FOREIGN KEY ("teamRunId") REFERENCES "TeamRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RoomMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamRunId" TEXT NOT NULL,
    "senderType" TEXT NOT NULL,
    "senderId" TEXT,
    "senderInvocationId" TEXT,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "mentions" TEXT NOT NULL,
    "workRequestIds" TEXT,
    "artifactRefs" TEXT,
    "attachmentIds" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoomMessage_teamRunId_fkey" FOREIGN KEY ("teamRunId") REFERENCES "TeamRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamRunId" TEXT NOT NULL,
    "requesterMemberId" TEXT,
    "requesterType" TEXT NOT NULL,
    "targetMemberId" TEXT NOT NULL,
    "triggerMessageId" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "ifBusy" TEXT NOT NULL DEFAULT 'queue',
    "cancelQueued" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkRequest_teamRunId_fkey" FOREIGN KEY ("teamRunId") REFERENCES "TeamRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentInvocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamRunId" TEXT NOT NULL,
    "workRequestId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "sessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "roomReplyReminderCount" INTEGER NOT NULL DEFAULT 0,
    "nextRoomReplyReminderAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentInvocation_teamRunId_fkey" FOREIGN KEY ("teamRunId") REFERENCES "TeamRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TeamTemplateMember_teamTemplateId_idx" ON "TeamTemplateMember"("teamTemplateId");

-- CreateIndex
CREATE INDEX "TeamTemplateMember_memberPresetId_idx" ON "TeamTemplateMember"("memberPresetId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamRun_taskId_key" ON "TeamRun"("taskId");

-- CreateIndex
CREATE INDEX "TeamMember_teamRunId_idx" ON "TeamMember"("teamRunId");

-- CreateIndex
CREATE INDEX "RoomMessage_teamRunId_idx" ON "RoomMessage"("teamRunId");

-- CreateIndex
CREATE INDEX "RoomMessage_senderInvocationId_idx" ON "RoomMessage"("senderInvocationId");

-- CreateIndex
CREATE INDEX "WorkRequest_teamRunId_idx" ON "WorkRequest"("teamRunId");

-- CreateIndex
CREATE INDEX "WorkRequest_targetMemberId_idx" ON "WorkRequest"("targetMemberId");

-- CreateIndex
CREATE INDEX "WorkRequest_status_idx" ON "WorkRequest"("status");

-- CreateIndex
CREATE INDEX "AgentInvocation_teamRunId_idx" ON "AgentInvocation"("teamRunId");

-- CreateIndex
CREATE INDEX "AgentInvocation_memberId_idx" ON "AgentInvocation"("memberId");

-- CreateIndex
CREATE INDEX "AgentInvocation_sessionId_idx" ON "AgentInvocation"("sessionId");

-- CreateIndex
CREATE INDEX "AgentInvocation_status_idx" ON "AgentInvocation"("status");
