CREATE TABLE "SessionTranslationCheckpoint" (
    "sessionId" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    CONSTRAINT "SessionTranslationCheckpoint_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SessionTranslationCheckpoint_token_sessionId_idx" ON "SessionTranslationCheckpoint"("token", "sessionId");
