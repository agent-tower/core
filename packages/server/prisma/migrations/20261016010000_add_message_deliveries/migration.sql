-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "creationFingerprint" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "creationSubmissionId" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "creationFingerprint" TEXT;
ALTER TABLE "Session" ADD COLUMN "creationSubmissionId" TEXT;
ALTER TABLE "Session" ADD COLUMN "initialDeliveryId" TEXT;
ALTER TABLE "Session" ADD COLUMN "inputIntent" TEXT;

-- CreateTable
CREATE TABLE "MessageDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientSubmissionId" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
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
    CONSTRAINT "MessageDelivery_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeliveryReceipt" (
    "deliveryId" TEXT NOT NULL PRIMARY KEY,
    "generation" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "runtimeInstanceId" TEXT,
    "turnId" TEXT,
    "evidence" TEXT,
    "submittedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeliveryReceipt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "MessageDelivery" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeliveryAction" (
    "actionId" TEXT NOT NULL PRIMARY KEY,
    "deliveryId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeliveryAction_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "MessageDelivery" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ConversationTurn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "deliveryId" TEXT,
    "originalText" TEXT,
    "deliveryRevision" INTEGER,
    "message" TEXT NOT NULL,
    "userEntryId" TEXT,
    "providerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ConversationTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConversationTurn_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "MessageDelivery" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ConversationTurn" ("attempts", "completedAt", "createdAt", "id", "lastError", "message", "providerId", "queuedAt", "sessionId", "startedAt", "status", "updatedAt", "userEntryId") SELECT "attempts", "completedAt", "createdAt", "id", "lastError", "message", "providerId", "queuedAt", "sessionId", "startedAt", "status", "updatedAt", "userEntryId" FROM "ConversationTurn";
DROP TABLE "ConversationTurn";
ALTER TABLE "new_ConversationTurn" RENAME TO "ConversationTurn";
CREATE UNIQUE INDEX "ConversationTurn_deliveryId_key" ON "ConversationTurn"("deliveryId");
CREATE INDEX "ConversationTurn_sessionId_status_queuedAt_idx" ON "ConversationTurn"("sessionId", "status", "queuedAt");
CREATE INDEX "ConversationTurn_status_queuedAt_idx" ON "ConversationTurn"("status", "queuedAt");
CREATE TABLE "new_TranslationSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "laneKey" TEXT NOT NULL,
    "sessionId" TEXT,
    "turnId" TEXT,
    "blockId" TEXT,
    "messageId" TEXT,
    "deliveryId" TEXT,
    "direction" TEXT NOT NULL,
    "originalText" TEXT NOT NULL,
    "sourceRevision" INTEGER NOT NULL DEFAULT 1,
    "sourceHash" TEXT NOT NULL,
    "blockState" TEXT NOT NULL DEFAULT 'OPEN',
    "jobState" TEXT NOT NULL DEFAULT 'OPEN',
    "currentAttemptVersion" INTEGER NOT NULL DEFAULT 0,
    "effectiveAttemptId" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "enableEpoch" INTEGER NOT NULL DEFAULT 0,
    "retryChainId" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "budgetStartedAt" DATETIME,
    "nextRetryAt" DATETIME,
    "deletedAt" DATETIME,
    "overlayRevision" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TranslationSource_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "MessageDelivery" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TranslationSource" ("blockId", "blockState", "budgetStartedAt", "createdAt", "currentAttemptVersion", "deletedAt", "deliveryId", "direction", "effectiveAttemptId", "enableEpoch", "errorCode", "generation", "id", "jobState", "laneKey", "messageId", "nextRetryAt", "originalText", "overlayRevision", "retryChainId", "retryCount", "scopeId", "scopeType", "sessionId", "sourceHash", "sourceKey", "sourceKind", "sourceRevision", "turnId", "updatedAt") SELECT "blockId", "blockState", "budgetStartedAt", "createdAt", "currentAttemptVersion", "deletedAt", "deliveryId", "direction", "effectiveAttemptId", "enableEpoch", "errorCode", "generation", "id", "jobState", "laneKey", "messageId", "nextRetryAt", "originalText", "overlayRevision", "retryChainId", "retryCount", "scopeId", "scopeType", "sessionId", "sourceHash", "sourceKey", "sourceKind", "sourceRevision", "turnId", "updatedAt" FROM "TranslationSource";
DROP TABLE "TranslationSource";
ALTER TABLE "new_TranslationSource" RENAME TO "TranslationSource";
CREATE INDEX "TranslationSource_scopeType_scopeId_deletedAt_idx" ON "TranslationSource"("scopeType", "scopeId", "deletedAt");
CREATE INDEX "TranslationSource_jobState_nextRetryAt_idx" ON "TranslationSource"("jobState", "nextRetryAt");
CREATE INDEX "TranslationSource_sessionId_idx" ON "TranslationSource"("sessionId");
CREATE INDEX "TranslationSource_messageId_idx" ON "TranslationSource"("messageId");
CREATE UNIQUE INDEX "TranslationSource_sourceKind_sourceKey_direction_key" ON "TranslationSource"("sourceKind", "sourceKey", "direction");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "MessageDelivery_clientSubmissionId_key" ON "MessageDelivery"("clientSubmissionId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageDelivery_translationSourceId_key" ON "MessageDelivery"("translationSourceId");

-- CreateIndex
CREATE INDEX "MessageDelivery_sessionId_sequence_idx" ON "MessageDelivery"("sessionId", "sequence");

-- CreateIndex
CREATE INDEX "MessageDelivery_state_updatedAt_idx" ON "MessageDelivery"("state", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageDelivery_channelKey_sequence_key" ON "MessageDelivery"("channelKey", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_creationSubmissionId_key" ON "Workspace"("creationSubmissionId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_creationSubmissionId_key" ON "Session"("creationSubmissionId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_initialDeliveryId_key" ON "Session"("initialDeliveryId");
