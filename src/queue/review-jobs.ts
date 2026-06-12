import { Queue } from "bullmq";
import { z } from "zod";
import type { RedisClient } from "../server/redis.js";

export const REVIEW_QUEUE_NAME = "hubolt-review-jobs";

export const ReviewJobSchema = z.object({
  orgId: z.string().min(1),
  repoId: z.string().min(1),
  repoFullName: z.string().min(1),
  prNumber: z.number().int().positive(),
  headSha: z.string().min(1),
  baseSha: z.string().min(1),
  baseRef: z.string().min(1),
  action: z.string().min(1),
  deliveryId: z.string().optional()
});
export type ReviewJob = z.infer<typeof ReviewJobSchema>;

/**
 * Stable id for a review job. GitHub redelivers webhooks (manual redelivery,
 * retries), so the id is derived from what is being reviewed rather than the
 * delivery: the same PR head can only be enqueued once.
 */
export function reviewJobId(job: Pick<ReviewJob, "repoId" | "prNumber" | "headSha">): string {
  return `${job.repoId}:${job.prNumber}:${job.headSha}`;
}

export interface EnqueueReviewResult {
  jobId: string;
  created: boolean;
}

/** The subset of a BullMQ queue the producer needs; narrow for testability. */
export interface ReviewQueueLike {
  getJob(jobId: string): Promise<{ id?: string } | null | undefined>;
  add(name: string, data: ReviewJob, opts: Record<string, unknown>): Promise<{ id?: string }>;
  close(): Promise<void>;
}

export class ReviewJobProducer {
  constructor(private queue: ReviewQueueLike) {}

  async enqueue(job: ReviewJob): Promise<EnqueueReviewResult> {
    const validated = ReviewJobSchema.parse(job);
    const jobId = reviewJobId(validated);

    const existing = await this.queue.getJob(jobId);
    if (existing) {
      return { jobId, created: false };
    }

    try {
      await this.queue.add("review-pr", validated, {
        jobId,
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000
        },
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 86400 }
      });
    } catch (error) {
      // A concurrent delivery may have added the job between getJob and add;
      // BullMQ rejects duplicate ids, which for us means already enqueued.
      const concurrent = await this.queue.getJob(jobId);
      if (concurrent) {
        return { jobId, created: false };
      }
      throw error;
    }

    return { jobId, created: true };
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * Build a producer backed by a real BullMQ queue. The shared Redis client is
 * safe to reuse here: producers never issue blocking commands.
 */
export function createReviewJobProducer(redis: RedisClient): ReviewJobProducer {
  const queue = new Queue(REVIEW_QUEUE_NAME, { connection: redis });
  queue.on("error", (error) => {
    console.error("Review job queue error:", error);
  });
  return new ReviewJobProducer(queue as unknown as ReviewQueueLike);
}
