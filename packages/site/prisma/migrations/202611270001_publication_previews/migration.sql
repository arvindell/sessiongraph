BEGIN;
CREATE TABLE "sessiongraph"."PublicationPreview" (
    "accountId" TEXT NOT NULL,
    "sessionCount" INTEGER NOT NULL,
    "tokenCount" BIGINT,
    "tokensPartial" BOOLEAN NOT NULL,
    "revision" TEXT NOT NULL,
    "thumbnail" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PublicationPreview_pkey" PRIMARY KEY ("accountId")
);
COMMIT;
BEGIN;
CREATE INDEX ASYNC "PublicationPreview_updatedAt_accountId_idx" ON "sessiongraph"."PublicationPreview"("updatedAt", "accountId");
COMMIT;
BEGIN;
CREATE INDEX ASYNC "PublicationPreview_sessionCount_accountId_idx" ON "sessiongraph"."PublicationPreview"("sessionCount", "accountId");
COMMIT;
BEGIN;
CREATE INDEX ASYNC "PublicationPreview_tokenCount_accountId_idx" ON "sessiongraph"."PublicationPreview"("tokenCount", "accountId");
COMMIT;
