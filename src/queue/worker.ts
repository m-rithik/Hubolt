import { Worker, type ConnectionOptions } from "bullmq";
import type { PrismaClient } from "../generated/prisma/index.js";
import type { RedisClient } from "../server/redis.js";
import { getRedisConnectionOptions, toBullMqConnectionOptions } from "../server/redis.js";
import { getLLMProvider } from "../providers/llm/index.js";
import { GitHubScmProvider } from "../providers/scm/github/index.js";
import { REVIEW_QUEUE_NAME, ReviewJobSchema } from "./review-jobs.js";
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
  // Validate once at startup: a missing token failing per job would burn
  // three retries on every delivery before anyone notices the config error.
  if (!options.deps?.createScm && !(process.env.GITHUB_TOKEN || process.env.GH_TOKEN)) {
    throw new Error("Review worker requires GITHUB_TOKEN or GH_TOKEN to fetch pull requests");
  }

  const deps: ReviewProcessorDeps = {
    db: options.db,
    createScm:
      options.deps?.createScm ??
      ((job) => {
        const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
        if (!token) {
          throw new Error("Review worker requires GITHUB_TOKEN or GH_TOKEN to fetch pull requests");
        }
        return new GitHubScmProvider({ repoFullName: job.repoFullName, token });
      }),
    createLlm:
      options.deps?.createLlm ??
      ((config) => getLLMProvider(config.providers.llm, { model: config.providers.model }))
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
