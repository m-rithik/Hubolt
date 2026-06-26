import type { PrismaClient } from "../../generated/prisma/index.js";
import { BitbucketScmProvider } from "../../providers/scm/bitbucket/index.js";
import { getLLMProvider } from "../../providers/llm/index.js";
import { processReviewJob, type ReviewJobOutcome } from "../../queue/review-processor.js";
import type { ReviewJob } from "../../queue/review-jobs.js";
import { getBitbucketToken } from "./bitbucket-config.js";

export interface BitbucketReviewTarget {
  repoFullName: string;
  repoName: string;
  prNumber: number;
  action: string;
}

/**
 * Run a full hosted review for one Bitbucket pull request, reusing the shared
 * review pipeline (diff fetch, LLM review, persistence, posting). The repo is
 * auto-registered under the first organization so reviews and findings persist.
 * The PR's canonical head/base come from the API, not the webhook payload, so
 * short vs full commit hashes never cause a false "head moved" skip.
 */
export async function runBitbucketReview(
  db: PrismaClient,
  target: BitbucketReviewTarget
): Promise<ReviewJobOutcome> {
  const org = await db.organization.findFirst();
  if (!org) {
    throw new Error("No organization exists to attach the review to");
  }

  // Stored (dashboard) token first, then BITBUCKET_API_TOKEN.
  const token = await getBitbucketToken(db, org.id);
  if (!token) {
    throw new Error("No Bitbucket API token configured (dashboard or BITBUCKET_API_TOKEN)");
  }

  const repo = await db.repository.upsert({
    where: { orgId_fullName: { orgId: org.id, fullName: target.repoFullName } },
    create: {
      orgId: org.id,
      name: target.repoName,
      fullName: target.repoFullName,
      url: `https://bitbucket.org/${target.repoFullName}`
    },
    update: {}
  });

  const scm = new BitbucketScmProvider({ repoFullName: target.repoFullName, token });
  const pr = await scm.getPullRequest(target.prNumber);

  const job: ReviewJob = {
    orgId: org.id,
    repoId: repo.id,
    repoFullName: target.repoFullName,
    prNumber: target.prNumber,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    baseRef: pr.baseRef,
    action: target.action
  };

  return processReviewJob(job, {
    db,
    createScm: () => scm,
    createLlm: (config) => {
      // The org's dashboard-selected provider/model wins (matching the GitHub
      // worker), then the repo .hubolt.yml. API key comes from the provider's
      // environment variable - the single-tenant/local path.
      // ponytail: per-org gateway-stored credentials are the multi-tenant slice.
      const provider = org.reviewLlmProvider ?? config.providers.llm;
      const model = org.reviewLlmModel ?? config.providers.model;
      // Reflect what actually ran in the report and persisted review, so the
      // summary and dashboard show the real provider/model, not the repo config.
      config.providers.llm = provider;
      config.providers.model = model;
      return getLLMProvider(provider, { model });
    }
  });
}
