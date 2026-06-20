-- Access level per API key. Existing keys become "admin" so current access is
-- unchanged; new viewer keys are read-only.
ALTER TABLE "api_keys" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'admin';
