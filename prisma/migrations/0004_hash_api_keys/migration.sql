-- Store only API key hashes. Existing plaintext keys are transformed in place
-- so already-issued local tokens keep working after this migration.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP INDEX IF EXISTS "api_keys_key_idx";
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_key_key";
ALTER TABLE "api_keys" RENAME COLUMN "key" TO "keyHash";
UPDATE "api_keys" SET "keyHash" = encode(digest("keyHash", 'sha256'), 'hex');

CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");
CREATE INDEX "api_keys_keyHash_idx" ON "api_keys"("keyHash");
