-- Username/password sessions and per-repository integration/access metadata that
-- are already represented in schema.prisma and server routes.

ALTER TABLE "organization_members" ALTER COLUMN "role" SET DEFAULT 'developer';
UPDATE "organization_members" SET "role" = 'developer' WHERE "role" = 'viewer';

ALTER TABLE "users" ADD COLUMN "username" TEXT;
ALTER TABLE "users" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "users" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");
CREATE INDEX "sessions_orgId_idx" ON "sessions"("orgId");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "repositories" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'github';
ALTER TABLE "repositories" ADD COLUMN "workspace" TEXT;
ALTER TABLE "repositories" ADD COLUMN "project" TEXT;
ALTER TABLE "repositories" ADD COLUMN "defaultBranch" TEXT;
ALTER TABLE "repositories" ADD COLUMN "environment" TEXT;

CREATE TABLE "repository_integrations" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "tokenFingerprint" TEXT NOT NULL,
    "tokenLast4" TEXT NOT NULL DEFAULT '',
    "encryptedWebhookSecret" TEXT,
    "webhookSecretFingerprint" TEXT,
    "encryptedSlackWebhook" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repository_integrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "repository_integrations_repoId_key" ON "repository_integrations"("repoId");
CREATE UNIQUE INDEX "repository_integrations_tokenFingerprint_key" ON "repository_integrations"("tokenFingerprint");
CREATE UNIQUE INDEX "repository_integrations_webhookSecretFingerprint_key" ON "repository_integrations"("webhookSecretFingerprint");
CREATE INDEX "repository_integrations_orgId_idx" ON "repository_integrations"("orgId");
ALTER TABLE "repository_integrations" ADD CONSTRAINT "repository_integrations_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "repository_integrations" ADD CONSTRAINT "repository_integrations_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "repository_access" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL DEFAULT 'read',
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_access_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "repository_access_repoId_memberId_key" ON "repository_access"("repoId", "memberId");
CREATE INDEX "repository_access_memberId_idx" ON "repository_access"("memberId");
ALTER TABLE "repository_access" ADD CONSTRAINT "repository_access_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "repository_access" ADD CONSTRAINT "repository_access_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "organization_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Short-lived idempotency locks. Rows are removed on normal completion and are
-- TTL-pruned before acquisition so a crashed worker does not block forever.
CREATE TABLE "review_locks" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_locks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_locks_repoId_prNumber_headSha_key" ON "review_locks"("repoId", "prNumber", "headSha");
CREATE INDEX "review_locks_expiresAt_idx" ON "review_locks"("expiresAt");
ALTER TABLE "review_locks" ADD CONSTRAINT "review_locks_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "review_ingest_locks" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_ingest_locks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_ingest_locks_repoId_fingerprint_key" ON "review_ingest_locks"("repoId", "fingerprint");
CREATE INDEX "review_ingest_locks_expiresAt_idx" ON "review_ingest_locks"("expiresAt");
ALTER TABLE "review_ingest_locks" ADD CONSTRAINT "review_ingest_locks_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Replay protection for mutating webhook events such as GitHub installation
-- add/remove deliveries. Signature validation proves authenticity, not freshness.
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "provider" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_deliveries_provider_deliveryId_key" ON "webhook_deliveries"("provider", "deliveryId");
CREATE INDEX "webhook_deliveries_createdAt_idx" ON "webhook_deliveries"("createdAt");
CREATE INDEX "webhook_deliveries_orgId_idx" ON "webhook_deliveries"("orgId");
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
