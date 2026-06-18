-- Conversation sessions run outside Project/Task/Workspace, but still reuse
-- Session/ExecutionProcess/MsgStore. SQLite cannot alter a NOT NULL relation
-- into nullable in place, so Session is rebuilt with the new shape.

CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "directoryName" TEXT NOT NULL,
    "workingDir" TEXT NOT NULL,
    "deletedAt" DATETIME,
    "lastActiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "Conversation_directoryName_key" ON "Conversation"("directoryName");
CREATE INDEX "Conversation_deletedAt_idx" ON "Conversation"("deletedAt");
CREATE INDEX "Conversation_lastActiveAt_idx" ON "Conversation"("lastActiveAt");

PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT,
    "conversationId" TEXT,
    "context" TEXT NOT NULL DEFAULT 'WORKSPACE',
    "agentType" TEXT NOT NULL,
    "variant" TEXT NOT NULL DEFAULT 'DEFAULT',
    "providerId" TEXT,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "purpose" TEXT NOT NULL DEFAULT 'CHAT',
    "logSnapshot" TEXT,
    "tokenUsage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Session_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Session_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_Session" (
    "id",
    "workspaceId",
    "context",
    "agentType",
    "variant",
    "providerId",
    "prompt",
    "status",
    "purpose",
    "logSnapshot",
    "tokenUsage",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    "workspaceId",
    'WORKSPACE',
    "agentType",
    "variant",
    "providerId",
    "prompt",
    "status",
    "purpose",
    "logSnapshot",
    "tokenUsage",
    "createdAt",
    "updatedAt"
FROM "Session";

DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";

CREATE UNIQUE INDEX "Session_conversationId_key" ON "Session"("conversationId");
CREATE INDEX "Session_workspaceId_idx" ON "Session"("workspaceId");
CREATE INDEX "Session_context_idx" ON "Session"("context");

PRAGMA foreign_keys=ON;
