import type { PrismaClient } from "../../generated/prisma/index.js";
import { BitbucketScmProvider } from "../../providers/scm/bitbucket/index.js";
import { processReviewJob, type ReviewJobOutcome } from "../../queue/review-processor.js";
import type { ReviewJob } from "../../queue/review-jobs.js";
import { getActiveReviewThreshold, isValidSeverity } from "./bitbucket-config.js";
import { SLACK_WEBHOOK_ENV, TEAMS_WEBHOOK_ENV } from "../../integrations/env-names.js";
import { createHostedReviewLlm } from "./review-llm.js";

/**
 * The tenant + credentials already resolved by the webhook (by matching the
 * delivery signature to a specific integration). Passing these in means the
 * review never falls back to organization.findFirst().
 */
export interface BitbucketReviewTarget {
  orgId: string;
  repoId: string;
  repoFullName: string;
  prNumber: number;
  action: string;
  token: string;
  slackWebhookUrl?: string;
}

/**
 * Run a full hosted review for one Bitbucket pull request, reusing the shared
 * review pipeline (diff fetch, LLM review, persistence, posting). Tenant, repo,
 * and token are resolved upstream by the webhook; the PR's canonical head/base
 * come from the API so short vs full commit hashes never cause a false skip.
 */
export async function runBitbucketReview(
  db: PrismaClient,
  target: BitbucketReviewTarget
): Promise<ReviewJobOutcome> {
  const org = await db.organization.findUnique({ where: { id: target.orgId } });
  if (!org) {
    throw new Error(`Organization ${target.orgId} not found`);
  }

  // Optional dashboard-set severity threshold override (else the repo config's).
  const thresholdOverride = await getActiveReviewThreshold(db, org.id);

  // Route notifications to THIS repo's Slack webhook only. Overriding the env
  // value (to the repo URL, or empty when none) guarantees a repo never falls
  // back to a common/org-wide Slack webhook.
  const slackWebhookUrl = target.slackWebhookUrl;
  const integrationEnv: NodeJS.ProcessEnv = {
    ...process.env,
    [SLACK_WEBHOOK_ENV]: slackWebhookUrl ?? "",
    [TEAMS_WEBHOOK_ENV]: ""
  };

  const scm = new BitbucketScmProvider({ repoFullName: target.repoFullName, token: target.token });
  const pr = await scm.getPullRequest(target.prNumber);

  const job: ReviewJob = {
    orgId: org.id,
    repoId: target.repoId,
    repoFullName: target.repoFullName,
    prNumber: target.prNumber,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    baseRef: pr.baseRef,
    action: target.action
  };

  return processReviewJob(job, {
    db,
    integrationEnv,
    createScm: () => scm,
    resolveReviewConfig: (config) => {
      // The org's dashboard-selected provider/model wins (matching the GitHub
      // worker), then the repo .hubolt.yml. This runs before budget reservation
      // so accounting, prompt/report metadata, and the actual model agree.
      const provider = org.reviewLlmProvider ?? config.providers.llm;
      const model = org.reviewLlmModel ?? config.providers.model;
      config.providers.llm = provider;
      config.providers.model = model;
      // Dashboard severity threshold override (affects both the prompt and the
      // post-filter, which run after this resolver).
      if (thresholdOverride && isValidSeverity(thresholdOverride)) {
        config.severityThreshold = thresholdOverride;
      }
      // Enable Slack only when this repo has its own webhook; combined with the
      // integrationEnv override above, this keeps notifications per-repo.
      config.integrations.slack.enabled = Boolean(slackWebhookUrl);
      return config;
    },
    createLlm: (config, job) => {
      // Match the GitHub worker: hosted reviews first use the org's encrypted
      // Gateway credential, falling back to env only when no stored key exists.
      const provider = config.providers.llm;
      const model = config.providers.model;
      return createHostedReviewLlm(db, job.orgId, provider, model);
    }
  });
}
