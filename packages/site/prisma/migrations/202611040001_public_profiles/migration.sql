BEGIN;

CREATE SCHEMA IF NOT EXISTS "public";

COMMIT;

BEGIN;

CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "username" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

COMMIT;

BEGIN;

CREATE TABLE "LoginSession" (
    "hash" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginSession_pkey" PRIMARY KEY ("hash")
);

COMMIT;

BEGIN;

CREATE TABLE "DeviceGrant" (
    "challenge" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceGrant_pkey" PRIMARY KEY ("challenge")
);

COMMIT;

BEGIN;

CREATE TABLE "Publication" (
    "accountId" TEXT NOT NULL,
    "graph" BYTEA NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Publication_pkey" PRIMARY KEY ("accountId")
);

COMMIT;

BEGIN;

CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

COMMIT;

BEGIN;

CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

COMMIT;

BEGIN;

CREATE TABLE "Membership" (
    "organizationId" UUID NOT NULL,
    "accountId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("organizationId","accountId")
);

COMMIT;

BEGIN;

CREATE TABLE "Invitation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "accountId" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

COMMIT;

BEGIN;

CREATE UNIQUE INDEX ASYNC "Account_username_key" ON "Account"("username");

COMMIT;

BEGIN;

CREATE INDEX ASYNC "LoginSession_accountId_idx" ON "LoginSession"("accountId");

COMMIT;

BEGIN;

CREATE INDEX ASYNC "LoginSession_expiresAt_idx" ON "LoginSession"("expiresAt");

COMMIT;

BEGIN;

CREATE INDEX ASYNC "DeviceGrant_expiresAt_idx" ON "DeviceGrant"("expiresAt");

COMMIT;

BEGIN;

CREATE INDEX ASYNC "RateLimit_expiresAt_idx" ON "RateLimit"("expiresAt");

COMMIT;

BEGIN;

CREATE UNIQUE INDEX ASYNC "Organization_slug_key" ON "Organization"("slug");

COMMIT;

BEGIN;

CREATE INDEX ASYNC "Membership_accountId_idx" ON "Membership"("accountId");

COMMIT;

BEGIN;

CREATE INDEX ASYNC "Invitation_accountId_idx" ON "Invitation"("accountId");

COMMIT;

BEGIN;

CREATE UNIQUE INDEX ASYNC "Invitation_organizationId_accountId_key" ON "Invitation"("organizationId", "accountId");

COMMIT;
