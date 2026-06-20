-- Per-org review LLM selection: provider names a gateway-stored credential,
-- model is free-form. Null falls back to repo config / server env.
ALTER TABLE "organizations" ADD COLUMN "reviewLlmProvider" TEXT;
ALTER TABLE "organizations" ADD COLUMN "reviewLlmModel" TEXT;

-- Soft-disable a repository on removal so its reviews/findings survive instead
-- of cascading away with the row.
ALTER TABLE "repositories" ADD COLUMN "disabledAt" TIMESTAMP(3);
