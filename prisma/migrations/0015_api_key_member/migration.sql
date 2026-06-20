-- Optionally tie an API key to the org member who owns it. Removing the member
-- clears the link (SET NULL) rather than deleting the key.
ALTER TABLE "api_keys" ADD COLUMN "memberId" TEXT;

ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "organization_members"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "api_keys_memberId_idx" ON "api_keys"("memberId");
