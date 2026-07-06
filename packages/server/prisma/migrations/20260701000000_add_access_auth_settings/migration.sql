CREATE TABLE "AccessAuthSettings" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "passwordHash" TEXT,
  "sessionSecret" TEXT NOT NULL,
  "passwordUpdatedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
