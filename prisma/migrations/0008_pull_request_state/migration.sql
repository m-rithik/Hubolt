-- Tracks the last reviewed head per pull request so synchronize events can
-- review incrementally and completed-job redeliveries can be skipped.
CREATE TABLE "pull_request_states" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_request_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pull_request_states_repoId_prNumber_key" ON "pull_request_states"("repoId", "prNumber");

ALTER TABLE "pull_request_states" ADD CONSTRAINT "pull_request_states_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
