-- CreateTable
CREATE TABLE "TranslationSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "enableEpoch" INTEGER NOT NULL DEFAULT 0,
    "apiBaseUrl" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "apiKey" TEXT,
    "credentialRevision" INTEGER NOT NULL DEFAULT 0,
    "sendTargetLanguage" TEXT NOT NULL DEFAULT 'English',
    "displayTargetLanguage" TEXT NOT NULL DEFAULT '简体中文',
    "promptTemplate" TEXT NOT NULL DEFAULT '请将以下内容翻译为 {{target_language}}，保持原意，只返回译文：

{{text}}',
    "maxConcurrency" INTEGER NOT NULL DEFAULT 4,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TranslationSource" (
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
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TranslationAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "attemptVersion" INTEGER NOT NULL,
    "configRevision" INTEGER NOT NULL,
    "credentialRevision" INTEGER NOT NULL,
    "targetLanguage" TEXT NOT NULL,
    "sanitizedConfigSnapshot" TEXT NOT NULL,
    "protectionVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "resultText" TEXT,
    "errorCode" TEXT,
    "generation" INTEGER NOT NULL,
    "enableEpoch" INTEGER NOT NULL,
    "retryIndex" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" DATETIME,
    "leaseOwner" TEXT,
    "leaseExpiresAt" DATETIME,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "TranslationAttempt_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TranslationSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TranslationSource_scopeType_scopeId_deletedAt_idx" ON "TranslationSource"("scopeType", "scopeId", "deletedAt");

-- CreateIndex
CREATE INDEX "TranslationSource_jobState_nextRetryAt_idx" ON "TranslationSource"("jobState", "nextRetryAt");

-- CreateIndex
CREATE INDEX "TranslationSource_sessionId_idx" ON "TranslationSource"("sessionId");

-- CreateIndex
CREATE INDEX "TranslationSource_messageId_idx" ON "TranslationSource"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "TranslationSource_sourceKind_sourceKey_direction_key" ON "TranslationSource"("sourceKind", "sourceKey", "direction");

-- CreateIndex
CREATE INDEX "TranslationAttempt_status_nextRetryAt_idx" ON "TranslationAttempt"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "TranslationAttempt_sourceId_sourceRevision_idx" ON "TranslationAttempt"("sourceId", "sourceRevision");

-- CreateIndex
CREATE UNIQUE INDEX "TranslationAttempt_sourceId_attemptVersion_key" ON "TranslationAttempt"("sourceId", "attemptVersion");

