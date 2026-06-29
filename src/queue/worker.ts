import { Worker, type ConnectionOptions } from "bullmq";
import type { PrismaClient } from "../generated/prisma/index.js";
import type { RedisClient } from "../server/redis.js";
import { getRedisConnectionOptions, toBullMqConnectionOptions } from "../server/redis.js";
import type { RepoConfig } from "../config/schema.js";
import type { LLMProvider } from "../types/providers.js";
import { GitHubScmProvider } from "../providers/scm/github/index.js";
import { getGitHubAppAuth, isGitHubAppConfigured } from "../server/services/github-app.js";
import { createHostedReviewLlm } from "../server/services/review-llm.js";
import { REVIEW_QUEUE_NAME, ReviewJobSchema, type ReviewJob } from "./review-jobs.js";
import { processReviewJob, type ReviewProcessorDeps } from "./review-processor.js";

export interface StartReviewWorkerOptions {
  db: PrismaClient;
  redis: RedisClient;
  /** Override processor dependencies; used by tests. */
  deps?: Partial<ReviewProcessorDeps>;
  concurrency?: number;
}

export interface ReviewWorkerHandle {
  close(): Promise<void>;
}

/**
 * Start the BullMQ worker that consumes review jobs produced by the webhook
 * route. The worker owns the expensive processing; the webhook handler only
 * verifies and enqueues.
 */
export function startReviewWorker(options: StartReviewWorkerOptions): ReviewWorkerHandle {
  // Validate once at startup: a missing credential failing per job would burn
  // three retries on every delivery before anyone notices the config error.
  // Either a configured GitHub App or a fallback env token is sufficient.
  if (
    !options.deps?.createScm &&
    !isGitHubAppConfigured() &&
    !(process.env.GITHUB_TOKEN || process.env.GH_TOKEN)
  ) {
    throw new Error(
      "Review worker requires a GitHub App (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY) or GITHUB_TOKEN/GH_TOKEN"
    );
  }

  const deps: ReviewProcessorDeps = {
    db: options.db,
    createScm:
      options.deps?.createScm ??
      (async (job) => {
        // Prefer a per-installation App token so any admin-added repo works
        // without a shared PAT; fall back to the env token otherwise.
        const token =
          job.installationId && isGitHubAppConfigured()
            ? await getGitHubAppAuth().getInstallationToken(job.installationId)
            : process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
        if (!token) {
          throw new Error("No GitHub credential available to fetch pull requests");
        }
        return new GitHubScmProvider({ repoFullName: job.repoFullName, token });
      }),
    createLlm:
      options.deps?.createLlm ??
      ((config, job) => createReviewLlm(options.db, job, config)),
    resolveReviewConfig:
      options.deps?.resolveReviewConfig ??
      ((config, job) => resolveReviewConfig(options.db, job, config))
  };

  const worker = new Worker(
    REVIEW_QUEUE_NAME,
    async (job) => {
      const reviewJob = ReviewJobSchema.parse(job.data);
      const outcome = await processReviewJob(reviewJob, deps);

      if (outcome.status === "skipped") {
        console.log(`Review job ${job.id}: skipped (${outcome.reason})`);
      } else if (outcome.posted) {
        console.log(
          `Review job ${job.id}: review ${outcome.reviewId} with ${outcome.findingCount} finding(s), ` +
            `${outcome.posted.inlinePosted} inline comment(s), summary ${outcome.posted.summaryAction}` +
            (outcome.incremental ? " (incremental)" : "")
        );
      } else {
        console.warn(
          `Review job ${job.id}: review ${outcome.reviewId} persisted with ${outcome.findingCount} finding(s), ` +
            `but posting to the pull request failed: ${outcome.postError ?? "unknown error"}`
        );
      }

      return outcome;
    },
    {
      connection: buildWorkerConnection(options.redis),
      concurrency: options.concurrency ?? 2,
      lockDuration: 120000
    }
  );

  attachWorkerLogging(worker);

  return {
    close: async () => {
      await worker.close();
    }
  };
}

function buildWorkerConnection(redis: RedisClient): ConnectionOptions {
  const base = getRedisConnectionOptions(redis);
  return toBullMqConnectionOptions({
    ...base,
    url: process.env.REDIS_URL || base.url
  }) as ConnectionOptions;
}

function attachWorkerLogging(worker: Worker): void {
  worker.on("error", (error) => {
    console.error("Review worker error:", error);
  });

  worker.on("failed", (job, error) => {
    console.error(`Review job ${job?.id} failed:`, error.message);
  });
}

/**
 * Build the LLM from the finalized review config. resolveReviewConfig applies
 * the org's gateway-selected provider/model before budget reservation.
 */
async function createReviewLlm(db: PrismaClient, job: ReviewJob, config: RepoConfig): Promise<LLMProvider> {
  const provider = config.providers.llm;
  const model = config.providers.model;

  return createHostedReviewLlm(db, job.orgId, provider, model);
}

/**
 * Resolve the org dashboard-selected provider/model before budget reservation
 * and report persistence. createReviewLlm receives this finalized config.
 */
async function resolveReviewConfig(db: PrismaClient, job: ReviewJob, config: RepoConfig): Promise<RepoConfig> {
  try {
    const org = await db.organization.findUnique({
      where: { id: job.orgId },
      select: { reviewLlmProvider: true, reviewLlmModel: true }
    });
    if (org?.reviewLlmProvider) config.providers.llm = org.reviewLlmProvider;
    if (org?.reviewLlmModel) config.providers.model = org.reviewLlmModel;
  } catch (error) {
    console.warn(
      "Could not load org review model; using config defaults:",
      error instanceof Error ? error.message : error
    );
  }

  return config;
}
