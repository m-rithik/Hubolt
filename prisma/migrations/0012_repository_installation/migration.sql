-- A registered repository is reviewed via a GitHub App installation. The id is
-- nullable: a repo can be registered from the dashboard before the App is
-- installed on it. The worker reads it to mint an installation access token.
ALTER TABLE "repositories" ADD COLUMN "installationId" TEXT;

-- Installation webhooks (installation_repositories) fan out by installation id.
CREATE INDEX "repositories_installationId_idx" ON "repositories"("installationId");
