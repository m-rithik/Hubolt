-- Phase 6: finding feedback (accepted/dismissed/discussed) and memory cards.

CREATE TABLE "finding_feedback" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "repoId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT,
    "verdict" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "actor" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finding_feedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "finding_feedback_orgId_externalId_key" ON "finding_feedback"("orgId", "externalId");
CREATE INDEX "finding_feedback_orgId_fingerprint_idx" ON "finding_feedback"("orgId", "fingerprint");
CREATE INDEX "finding_feedback_orgId_ruleId_idx" ON "finding_feedback"("orgId", "ruleId");

ALTER TABLE "finding_feedback" ADD CONSTRAINT "finding_feedback_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "memory_cards" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL DEFAULT '',
    "ruleId" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tokensEstimate" INTEGER NOT NULL DEFAULT 0,
    "sourceCount" INTEGER NOT NULL DEFAULT 0,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_cards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_cards_orgId_repoId_kind_ruleId_key" ON "memory_cards"("orgId", "repoId", "kind", "ruleId");
CREATE INDEX "memory_cards_orgId_idx" ON "memory_cards"("orgId");

ALTER TABLE "memory_cards" ADD CONSTRAINT "memory_cards_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "findings_fingerprint_idx" ON "findings"("fingerprint");
CREATE INDEX "findings_createdAt_idx" ON "findings"("createdAt");

ALTER TABLE "reviews" ADD COLUMN "orgId" TEXT;
UPDATE "reviews"
SET "orgId" = "repositories"."orgId"
FROM "repositories"
WHERE "reviews"."repoId" = "repositories"."id";
ALTER TABLE "reviews" ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "reviews_orgId_createdAt_idx" ON "reviews"("orgId", "createdAt");

ALTER TABLE "findings" ADD COLUMN "orgId" TEXT;
ALTER TABLE "findings" ADD COLUMN "repoId" TEXT;
UPDATE "findings"
SET
  "orgId" = "reviews"."orgId",
  "repoId" = "reviews"."repoId"
FROM "reviews"
WHERE "findings"."reviewId" = "reviews"."id";
ALTER TABLE "findings" ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "findings" ALTER COLUMN "repoId" SET NOT NULL;
ALTER TABLE "findings" ADD CONSTRAINT "findings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "findings" ADD CONSTRAINT "findings_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "findings_orgId_createdAt_idx" ON "findings"("orgId", "createdAt");
CREATE INDEX "findings_repoId_idx" ON "findings"("repoId");
