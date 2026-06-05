-- Remove old unique constraint on fullName
ALTER TABLE "repositories" DROP CONSTRAINT IF EXISTS "repositories_fullName_key";

-- Add new unique constraint on (orgId, fullName)
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_orgId_fullName_key" UNIQUE ("orgId", "fullName");
