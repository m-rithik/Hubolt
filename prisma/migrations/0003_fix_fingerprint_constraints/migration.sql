-- Remove global unique constraints on fingerprints
ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "reviews_fingerprint_key";
ALTER TABLE "findings" DROP CONSTRAINT IF EXISTS "findings_fingerprint_key";

-- Add composite unique constraints
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_repoId_fingerprint_key" UNIQUE ("repoId", "fingerprint");
ALTER TABLE "findings" ADD CONSTRAINT "findings_reviewId_fingerprint_key" UNIQUE ("reviewId", "fingerprint");
