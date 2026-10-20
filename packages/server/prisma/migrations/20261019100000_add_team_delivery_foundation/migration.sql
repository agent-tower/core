-- CreateTable
CREATE TABLE "TeamTaskInputSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamRunId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "taskSourceHash" TEXT NOT NULL,
    "originalTitle" TEXT NOT NULL,
    "originalDescription" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "effectiveUserText" TEXT,
    "translationSourceId" TEXT,
    "acceptedAttemptId" TEXT,
    "sentMode" TEXT,
    "acceptedAt" DATETIME,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TeamTaskInputSnapshot_teamRunId_fkey" FOREIGN KEY ("teamRunId") REFERENCES "TeamRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamTaskInputSnapshot_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamTaskInputSnapshot_translationSourceId_fkey" FOREIGN KEY ("translationSourceId") REFERENCES "TranslationSource" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TeamTaskInputSnapshot_acceptedAttemptId_fkey" FOREIGN KEY ("acceptedAttemptId") REFERENCES "TranslationAttempt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamTaskInputAction" (
    "actionId" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamTaskInputAction_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "TeamTaskInputSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TeamRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "mainWorkspaceId" TEXT,
    "mode" TEXT NOT NULL,
    "heartbeatTimeoutMinutes" INTEGER NOT NULL DEFAULT 10,
    "reviewReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "currentTaskInputSnapshotId" TEXT,
    CONSTRAINT "TeamRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamRun_mainWorkspaceId_fkey" FOREIGN KEY ("mainWorkspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TeamRun_currentTaskInputSnapshotId_fkey" FOREIGN KEY ("currentTaskInputSnapshotId") REFERENCES "TeamTaskInputSnapshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TeamRun" ("createdAt", "heartbeatTimeoutMinutes", "id", "mainWorkspaceId", "mode", "reviewReason", "taskId", "updatedAt") SELECT "createdAt", "heartbeatTimeoutMinutes", "id", "mainWorkspaceId", "mode", "reviewReason", "taskId", "updatedAt" FROM "TeamRun";
DROP TABLE "TeamRun";
ALTER TABLE "new_TeamRun" RENAME TO "TeamRun";
CREATE UNIQUE INDEX "TeamRun_taskId_key" ON "TeamRun"("taskId");
CREATE INDEX "TeamRun_mainWorkspaceId_idx" ON "TeamRun"("mainWorkspaceId");
CREATE TABLE "new_RoomMessage" (
    "deliveryId" TEXT,
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamRunId" TEXT NOT NULL,
    "senderType" TEXT NOT NULL,
    "senderId" TEXT,
    "senderInvocationId" TEXT,
    "kind" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
    "content" TEXT NOT NULL,
    "translationEligibilityEpoch" INTEGER,
    "mentions" TEXT NOT NULL,
    "workRequestIds" TEXT,
    "artifactRefs" TEXT,
    "attachmentIds" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoomMessage_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "MessageDelivery" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RoomMessage_teamRunId_fkey" FOREIGN KEY ("teamRunId") REFERENCES "TeamRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_RoomMessage" ("artifactRefs", "attachmentIds", "content", "createdAt", "id", "kind", "mentions", "senderId", "senderInvocationId", "senderType", "teamRunId", "translationEligibilityEpoch", "visibility", "workRequestIds") SELECT "artifactRefs", "attachmentIds", "content", "createdAt", "id", "kind", "mentions", "senderId", "senderInvocationId", "senderType", "teamRunId", "translationEligibilityEpoch", "visibility", "workRequestIds" FROM "RoomMessage";
DROP TABLE "RoomMessage";
ALTER TABLE "new_RoomMessage" RENAME TO "RoomMessage";
CREATE UNIQUE INDEX "RoomMessage_deliveryId_key" ON "RoomMessage"("deliveryId");
CREATE INDEX "RoomMessage_teamRunId_idx" ON "RoomMessage"("teamRunId");
CREATE INDEX "RoomMessage_teamRunId_visibility_idx" ON "RoomMessage"("teamRunId", "visibility");
CREATE INDEX "RoomMessage_senderInvocationId_idx" ON "RoomMessage"("senderInvocationId");
CREATE INDEX "RoomMessage_translationEligibilityEpoch_id_idx" ON "RoomMessage"("translationEligibilityEpoch", "id");
CREATE TABLE "new_WorkRequest" (
    "taskInputSnapshotId" TEXT,
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamRunId" TEXT NOT NULL,
    "requesterMemberId" TEXT,
    "requesterType" TEXT NOT NULL,
    "targetMemberId" TEXT NOT NULL,
    "targetKind" TEXT,
    "targetPurpose" TEXT,
    "targetSourceWorkspaceId" TEXT,
    "targetSourceMemberId" TEXT,
    "targetHeadSha" TEXT,
    "targetBranchName" TEXT,
    "targetPlanItemId" TEXT,
    "triggerMessageId" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "ifBusy" TEXT NOT NULL DEFAULT 'queue',
    "cancelQueued" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "startAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastStartError" TEXT,
    "nextStartRetryAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkRequest_taskInputSnapshotId_fkey" FOREIGN KEY ("taskInputSnapshotId") REFERENCES "TeamTaskInputSnapshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "WorkRequest_teamRunId_fkey" FOREIGN KEY ("teamRunId") REFERENCES "TeamRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WorkRequest" ("cancelQueued", "createdAt", "id", "ifBusy", "instruction", "lastStartError", "nextStartRetryAt", "requesterMemberId", "requesterType", "startAttemptCount", "status", "targetBranchName", "targetHeadSha", "targetKind", "targetMemberId", "targetPlanItemId", "targetPurpose", "targetSourceMemberId", "targetSourceWorkspaceId", "teamRunId", "triggerMessageId", "updatedAt") SELECT "cancelQueued", "createdAt", "id", "ifBusy", "instruction", "lastStartError", "nextStartRetryAt", "requesterMemberId", "requesterType", "startAttemptCount", "status", "targetBranchName", "targetHeadSha", "targetKind", "targetMemberId", "targetPlanItemId", "targetPurpose", "targetSourceMemberId", "targetSourceWorkspaceId", "teamRunId", "triggerMessageId", "updatedAt" FROM "WorkRequest";
DROP TABLE "WorkRequest";
ALTER TABLE "new_WorkRequest" RENAME TO "WorkRequest";
CREATE INDEX "WorkRequest_teamRunId_idx" ON "WorkRequest"("teamRunId");
CREATE INDEX "WorkRequest_targetMemberId_idx" ON "WorkRequest"("targetMemberId");
CREATE INDEX "WorkRequest_targetSourceWorkspaceId_idx" ON "WorkRequest"("targetSourceWorkspaceId");
CREATE INDEX "WorkRequest_targetHeadSha_idx" ON "WorkRequest"("targetHeadSha");
CREATE INDEX "WorkRequest_status_idx" ON "WorkRequest"("status");
CREATE INDEX "WorkRequest_status_nextStartRetryAt_idx" ON "WorkRequest"("status", "nextStartRetryAt");
CREATE INDEX "WorkRequest_taskInputSnapshotId_status_idx" ON "WorkRequest"("taskInputSnapshotId", "status");
CREATE TABLE "new_AgentInvocation" (
    "taskInputSnapshotId" TEXT,
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamRunId" TEXT NOT NULL,
    "workRequestId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "sessionId" TEXT,
    "targetKind" TEXT,
    "targetPurpose" TEXT,
    "targetSourceWorkspaceId" TEXT,
    "targetSourceMemberId" TEXT,
    "targetHeadSha" TEXT,
    "targetBranchName" TEXT,
    "targetPlanItemId" TEXT,
    "targetSyncStatus" TEXT,
    "targetSyncError" TEXT,
    "targetExecutionBranch" TEXT,
    "targetPort" INTEGER,
    "targetVitePort" INTEGER,
    "targetE2EPort" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "roomReplyReminderCount" INTEGER NOT NULL DEFAULT 0,
    "nextRoomReplyReminderAt" DATETIME,
    "lastHeartbeatAt" DATETIME,
    "firstNudgeAt" DATETIME,
    "dispatchRevokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentInvocation_taskInputSnapshotId_fkey" FOREIGN KEY ("taskInputSnapshotId") REFERENCES "TeamTaskInputSnapshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentInvocation_teamRunId_fkey" FOREIGN KEY ("teamRunId") REFERENCES "TeamRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AgentInvocation" ("createdAt", "dispatchRevokedAt", "firstNudgeAt", "id", "lastHeartbeatAt", "memberId", "nextRoomReplyReminderAt", "roomReplyReminderCount", "sessionId", "status", "targetBranchName", "targetE2EPort", "targetExecutionBranch", "targetHeadSha", "targetKind", "targetPlanItemId", "targetPort", "targetPurpose", "targetSourceMemberId", "targetSourceWorkspaceId", "targetSyncError", "targetSyncStatus", "targetVitePort", "teamRunId", "updatedAt", "workRequestId", "workspaceId") SELECT "createdAt", "dispatchRevokedAt", "firstNudgeAt", "id", "lastHeartbeatAt", "memberId", "nextRoomReplyReminderAt", "roomReplyReminderCount", "sessionId", "status", "targetBranchName", "targetE2EPort", "targetExecutionBranch", "targetHeadSha", "targetKind", "targetPlanItemId", "targetPort", "targetPurpose", "targetSourceMemberId", "targetSourceWorkspaceId", "targetSyncError", "targetSyncStatus", "targetVitePort", "teamRunId", "updatedAt", "workRequestId", "workspaceId" FROM "AgentInvocation";
DROP TABLE "AgentInvocation";
ALTER TABLE "new_AgentInvocation" RENAME TO "AgentInvocation";
CREATE INDEX "AgentInvocation_teamRunId_idx" ON "AgentInvocation"("teamRunId");
CREATE INDEX "AgentInvocation_memberId_idx" ON "AgentInvocation"("memberId");
CREATE INDEX "AgentInvocation_sessionId_idx" ON "AgentInvocation"("sessionId");
CREATE INDEX "AgentInvocation_targetSourceWorkspaceId_idx" ON "AgentInvocation"("targetSourceWorkspaceId");
CREATE INDEX "AgentInvocation_targetHeadSha_idx" ON "AgentInvocation"("targetHeadSha");
CREATE INDEX "AgentInvocation_targetSyncStatus_idx" ON "AgentInvocation"("targetSyncStatus");
CREATE INDEX "AgentInvocation_status_idx" ON "AgentInvocation"("status");
CREATE TABLE "new_MessageDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientSubmissionId" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "sessionId" TEXT,
    "taskId" TEXT,
    "teamRunId" TEXT,
    "taskInputSnapshotId" TEXT,
    "channelKey" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "originalText" TEXT NOT NULL,
    "attachmentIds" TEXT NOT NULL DEFAULT '[]',
    "intent" TEXT NOT NULL DEFAULT '{}',
    "sourceRevision" INTEGER NOT NULL DEFAULT 1,
    "sourceHash" TEXT NOT NULL,
    "translationSourceId" TEXT,
    "enableEpoch" INTEGER NOT NULL,
    "requiresTranslation" BOOLEAN NOT NULL,
    "state" TEXT NOT NULL,
    "sentMode" TEXT,
    "acceptedText" TEXT,
    "actualSentText" TEXT,
    "sentAt" DATETIME,
    "acceptedDestinationId" TEXT,
    "lastError" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MessageDelivery_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageDelivery_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageDelivery_teamRunId_fkey" FOREIGN KEY ("teamRunId") REFERENCES "TeamRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageDelivery_taskInputSnapshotId_fkey" FOREIGN KEY ("taskInputSnapshotId") REFERENCES "TeamTaskInputSnapshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_MessageDelivery" ("acceptedDestinationId", "acceptedText", "actualSentText", "attachmentIds", "channelKey", "clientSubmissionId", "createdAt", "enableEpoch", "id", "intent", "lastError", "origin", "originalText", "requestFingerprint", "requiresTranslation", "revision", "sentAt", "sentMode", "sequence", "sessionId", "sourceHash", "sourceRevision", "state", "translationSourceId", "updatedAt") SELECT "acceptedDestinationId", "acceptedText", "actualSentText", "attachmentIds", "channelKey", "clientSubmissionId", "createdAt", "enableEpoch", "id", "intent", "lastError", "origin", "originalText", "requestFingerprint", "requiresTranslation", "revision", "sentAt", "sentMode", "sequence", "sessionId", "sourceHash", "sourceRevision", "state", "translationSourceId", "updatedAt" FROM "MessageDelivery";
DROP TABLE "MessageDelivery";
ALTER TABLE "new_MessageDelivery" RENAME TO "MessageDelivery";
CREATE UNIQUE INDEX "MessageDelivery_clientSubmissionId_key" ON "MessageDelivery"("clientSubmissionId");
CREATE UNIQUE INDEX "MessageDelivery_translationSourceId_key" ON "MessageDelivery"("translationSourceId");
CREATE INDEX "MessageDelivery_sessionId_sequence_idx" ON "MessageDelivery"("sessionId", "sequence");
CREATE INDEX "MessageDelivery_taskId_sequence_idx" ON "MessageDelivery"("taskId", "sequence");
CREATE INDEX "MessageDelivery_teamRunId_sequence_idx" ON "MessageDelivery"("teamRunId", "sequence");
CREATE INDEX "MessageDelivery_taskInputSnapshotId_idx" ON "MessageDelivery"("taskInputSnapshotId");
CREATE INDEX "MessageDelivery_channelKey_state_sequence_idx" ON "MessageDelivery"("channelKey", "state", "sequence");
CREATE INDEX "MessageDelivery_state_updatedAt_idx" ON "MessageDelivery"("state", "updatedAt");
CREATE UNIQUE INDEX "MessageDelivery_channelKey_sequence_key" ON "MessageDelivery"("channelKey", "sequence");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "TeamTaskInputSnapshot_translationSourceId_key" ON "TeamTaskInputSnapshot"("translationSourceId");

-- CreateIndex
CREATE INDEX "TeamTaskInputSnapshot_teamRunId_state_idx" ON "TeamTaskInputSnapshot"("teamRunId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "TeamTaskInputSnapshot_teamRunId_taskSourceHash_key" ON "TeamTaskInputSnapshot"("teamRunId", "taskSourceHash");
