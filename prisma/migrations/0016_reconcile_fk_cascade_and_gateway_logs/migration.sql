-- Reconcile the migration history with schema.prisma so `prisma migrate diff`
-- reports no drift and the CI drift gate can be blocking.
--
-- Two real differences existed in a database built purely from migrations:
--   1. Foreign keys were created without the ON DELETE/UPDATE CASCADE that the
--      schema relations declare, so cascade deletes (e.g. removing an org or a
--      review) were not enforced at the database level. Re-create them with the
--      cascade actions the schema expects. Non-destructive: dropping and adding
--      a constraint re-validates existing rows, it does not delete data.
--   2. The gateway_logs table was renamed from llm_gateway_requests in an
--      earlier migration without renaming its primary key and indexes. Rename
--      them to match (metadata-only).

-- DropForeignKey
ALTER TABLE "analyzer_signals" DROP CONSTRAINT "analyzer_signals_reviewId_fkey";

-- DropForeignKey
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_orgId_fkey";

-- DropForeignKey
ALTER TABLE "budgets" DROP CONSTRAINT "budgets_orgId_fkey";

-- DropForeignKey
ALTER TABLE "findings" DROP CONSTRAINT "findings_reviewId_fkey";

-- DropForeignKey
ALTER TABLE "model_usage" DROP CONSTRAINT "model_usage_reviewId_fkey";

-- DropForeignKey
ALTER TABLE "organization_members" DROP CONSTRAINT "organization_members_orgId_fkey";

-- DropForeignKey
ALTER TABLE "organization_members" DROP CONSTRAINT "organization_members_userId_fkey";

-- DropForeignKey
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_orgId_fkey";

-- DropForeignKey
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_repoId_fkey";

-- AlterTable
ALTER TABLE "gateway_logs" RENAME CONSTRAINT "llm_gateway_requests_pkey" TO "gateway_logs_pkey";

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analyzer_signals" ADD CONSTRAINT "analyzer_signals_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "llm_gateway_requests_createdAt_idx" RENAME TO "gateway_logs_createdAt_idx";

-- RenameIndex
ALTER INDEX "llm_gateway_requests_orgId_idx" RENAME TO "gateway_logs_orgId_idx";
