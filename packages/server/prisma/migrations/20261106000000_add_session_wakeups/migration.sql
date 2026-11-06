-- CreateTable
CREATE TABLE "SessionWakeup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "serviceId" TEXT,
    "serviceName" TEXT,
    "fireAt" DATETIME,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "payload" TEXT NOT NULL DEFAULT '{}',
    "deliveryId" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "firedAt" DATETIME,
    CONSTRAINT "SessionWakeup_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionWakeup_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "WorkspaceBackgroundService" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SessionWakeup_sessionId_state_idx" ON "SessionWakeup"("sessionId", "state");

-- CreateIndex
CREATE INDEX "SessionWakeup_state_fireAt_idx" ON "SessionWakeup"("state", "fireAt");

-- CreateIndex
CREATE INDEX "SessionWakeup_serviceId_state_idx" ON "SessionWakeup"("serviceId", "state");
