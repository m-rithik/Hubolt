import { Queue, Worker, QueueEvents, type ConnectionOptions } from "bullmq";
import { createHash } from "node:crypto";
import { GATEWAY_CONFIG } from "./constants.js";
import {
  getRedisConnectionOptions,
  toBullMqConnectionOptions,
  type RedisClient,
  type RedisConnectionOptions
} from "../redis.js";

export type BudgetReservationStatus = "reserved" | "reconciled" | "refunded";

export interface QueuedBudgetReservation {
  orgId: string;
  provider: string;
  estimatedCostUsd: number;
  status: BudgetReservationStatus;
  actualCostUsd?: number;
  settledAt?: string;
}

export interface QueuedRequest {
  id: string;
  orgId: string;
  provider: string;
  model: string;
  system: string;
  user: string;
  priority: number;
  promptHash: string;
  createdAt: Date;
  timeout: number;
  budgetReservation?: QueuedBudgetReservation;
}

export interface QueueResult {
  success: boolean;
  result?: unknown;
  error?: string;
  cached?: boolean;
  terminal?: boolean;
  state?: string;
}

export interface EnqueueResult {
  jobId: string;
  created: boolean;
}

export interface QueueSettlementHandlers {
  onCompleted?: (jobId: string, result: unknown) => Promise<void> | void;
  onFailed?: (jobId: string, error: string) => Promise<void> | void;
}

const DEFAULT_TIMEOUT_MS = GATEWAY_CONFIG.QUEUE_TIMEOUT_MS;
const MAX_QUEUE_ATTEMPTS = 3;

export class RequestQueue {
  private queue: Queue;
  private worker: Worker | null = null;
  private queueEvents: QueueEvents;
  private redisConnectionOptions: RedisConnectionOptions;
  private redisClient: any;
  private maxCacheSize = GATEWAY_CONFIG.MAX_CACHE_SIZE_BYTES;
  private cacheKeyPrefix = "llm:cache:";

  constructor(redis: RedisClient | RedisConnectionOptions) {
    this.redisConnectionOptions = this.resolveRedisConnectionOptions(redis);

    // Store Redis client if provided, for cache operations
    if (this.isRedisClient(redis)) {
      this.redisClient = redis;
    }

    this.queue = new Queue("llm-requests", { connection: this.createBullMqConnection() });
    this.queueEvents = new QueueEvents("llm-requests", { connection: this.createBullMqConnection() });
    this.queue.on("error", (error) => this.logBullMqError("queue", error));
    this.queueEvents.on("error", (error) => this.logBullMqError("queue events", error));
  }

  async init(
    processor: (req: QueuedRequest) => Promise<unknown>,
    settlementHandlers: QueueSettlementHandlers = {}
  ): Promise<void> {
    this.queueEvents.on("completed", ({ jobId, returnvalue }) => {
      void this.handleSettlement("completed", jobId, () => settlementHandlers.onCompleted?.(jobId, returnvalue));
    });

    this.queueEvents.on("failed", ({ jobId, failedReason }) => {
      void this.handleSettlement("failed", jobId, () => settlementHandlers.onFailed?.(jobId, failedReason));
    });

    this.worker = new Worker("llm-requests", async (job) => this.processJob(job, processor), {
      connection: this.createBullMqConnection(),
      concurrency: 10,
      maxStalledCount: 2,
      stalledInterval: 5000,
      lockDuration: 30000
    });

    this.worker.on("error", (error) => this.logBullMqError("worker", error));

    this.worker.on("failed", (job, err) => {
      console.error(`Job ${job?.id} failed:`, err);
    });

    this.worker.on("completed", (job) => {
      this.cleanOldCache();
    });
  }

  async enqueue(request: QueuedRequest): Promise<EnqueueResult> {
    const promptHash = request.promptHash;

    const existingJobId = await this.getReusableJobId(promptHash);
    if (existingJobId) {
      return { jobId: existingJobId, created: false };
    }

    return await this.addJob(request);
  }

  async getReusableJobId(promptHash: string): Promise<string | null> {
    const existingJob = await this.queue.getJob(promptHash);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === "failed") {
        await existingJob.remove();
      } else {
        return existingJob.id!;
      }
    }

    return null;
  }

  async remove(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (job) {
      await job.remove();
    }
  }

  async getQueuedRequest(jobId: string): Promise<QueuedRequest | null> {
    const job = await this.queue.getJob(jobId);
    return job?.data ?? null;
  }

  async getJob(jobId: string): Promise<any> {
    return await this.queue.getJob(jobId);
  }

  async isTerminalFailed(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) {
      return false;
    }

    if (typeof job.isFailed === "function") {
      return await job.isFailed();
    }

    return await job.getState() === "failed";
  }

  async getBudgetReservation(jobId: string): Promise<QueuedBudgetReservation | null> {
    const queuedRequest = await this.getQueuedRequest(jobId);
    return queuedRequest?.budgetReservation ?? null;
  }

  async markBudgetReservationSettled(
    jobId: string,
    status: Exclude<BudgetReservationStatus, "reserved">,
    actualCostUsd?: number
  ): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (!job) {
      return;
    }

    const queuedRequest = job.data as QueuedRequest;
    if (!queuedRequest.budgetReservation) {
      return;
    }

    await job.updateData({
      ...queuedRequest,
      budgetReservation: {
        ...queuedRequest.budgetReservation,
        status,
        actualCostUsd,
        settledAt: new Date().toISOString()
      }
    });
  }

  async getCachedResult(promptHash: string): Promise<any> {
    if (!this.redisClient) return null;

    try {
      const cacheKey = `${this.cacheKeyPrefix}${promptHash}`;
      const cached = await this.redisClient.get(cacheKey);

      if (!cached) return null;

      return this.parseCachedResult(cached);
    } catch (error) {
      console.error("Cache retrieval error:", error);
      return null;
    }
  }

  async getResult(jobId: string, timeout: number = DEFAULT_TIMEOUT_MS): Promise<QueueResult> {
    // Check cache first
    if (this.redisClient) {
      try {
        const cacheKey = `${this.cacheKeyPrefix}${jobId}`;
        const cached = await this.redisClient.get(cacheKey);

        if (cached) {
          return { success: true, result: this.parseCachedResult(cached), cached: true };
        }
      } catch (error) {
        console.error("Cache check error:", error);
      }
    }

    try {
      const job = await this.queue.getJob(jobId);
      if (!job) {
        return { success: false, error: "Job not found", terminal: true, state: "missing" };
      }

      const isCompleted = await job.isCompleted();
      const isFailed = await job.isFailed();

      if (isCompleted || isFailed) {
        const result = job.returnvalue;
        if (isFailed) {
          return { success: false, error: job.failedReason || "Job failed", terminal: true, state: "failed" };
        }
        await this.cacheResult(jobId, result);
        return { success: true, result, terminal: true, state: "completed" };
      }

      const result = await job.waitUntilFinished(this.queueEvents, timeout);
      await this.cacheResult(jobId, result);

      return { success: true, result, terminal: true, state: "completed" };
    } catch (error) {
      const job = await this.queue.getJob(jobId);
      if (!job) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          terminal: true,
          state: "missing"
        };
      }

      const state = await job.getState();
      if (state === "completed") {
        const result = job.returnvalue;
        await this.cacheResult(jobId, result);
        return { success: true, result, terminal: true, state };
      }

      if (state === "failed" || job.failedReason) {
        return { success: false, error: job.failedReason || "Job failed", terminal: true, state: "failed" };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        terminal: false,
        state
      };
    }
  }

  async getQueueStats() {
    const waiting = (await this.queue.getWaitingCount()) || 0;
    const active = (await this.queue.getActiveCount()) || 0;
    const completed = (await this.queue.getCompletedCount()) || 0;
    const failed = (await this.queue.getFailedCount()) || 0;
    const delayed = (await this.queue.getDelayedCount()) || 0;
    const isPaused = await this.queue.isPaused();

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      paused: isPaused
    };
  }

  async pause(): Promise<void> {
    await this.queue.pause();
  }

  async resume(): Promise<void> {
    await this.queue.resume();
  }

  async drain(): Promise<void> {
    await this.queue.drain();
  }

  async close(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
    await this.queue.close();
    await this.queueEvents.close();
  }

  private logBullMqError(source: string, error: unknown): void {
    console.error(`BullMQ ${source} error:`, error);
  }

  private resolveRedisConnectionOptions(redis: RedisClient | RedisConnectionOptions): RedisConnectionOptions {
    if (this.isRedisClient(redis)) {
      return getRedisConnectionOptions(redis);
    }

    return { ...redis };
  }

  private isRedisClient(redis: RedisClient | RedisConnectionOptions): redis is RedisClient {
    return typeof (redis as RedisClient).duplicate === "function";
  }

  private createBullMqConnection(): ConnectionOptions {
    const url = process.env.REDIS_URL || this.redisConnectionOptions.url;
    return toBullMqConnectionOptions({ ...this.redisConnectionOptions, url }) as ConnectionOptions;
  }

  private async handleSettlement(
    eventName: string,
    jobId: string,
    handler: () => Promise<void> | void
  ): Promise<void> {
    try {
      await handler();
    } catch (error) {
      console.error(`Failed to handle ${eventName} settlement for job ${jobId}:`, error);
    }
  }

  private async addJob(request: QueuedRequest): Promise<EnqueueResult> {
    try {
      const job = await this.queue.add(
        "process-request",
        request,
        {
          jobId: request.promptHash,
          priority: request.priority,
          attempts: MAX_QUEUE_ATTEMPTS,
          backoff: {
            type: "exponential",
            delay: 2000
          },
          removeOnComplete: {
            age: 3600
          },
          removeOnFail: {
            age: 3600
          }
        }
      );
      return { jobId: job.id!, created: true };
    } catch (error) {
      const existingJob = await this.queue.getJob(request.promptHash);
      if (existingJob) {
        return { jobId: existingJob.id!, created: false };
      }
      throw error;
    }
  }

  private async processJob(job: any, processor: (req: QueuedRequest) => Promise<unknown>): Promise<unknown> {
    const startTime = Date.now();

    try {
      const result = await processor(job.data);
      const duration = Date.now() - startTime;

      job.log(`Completed in ${duration}ms`);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`Job processing failed after ${duration}ms:`, error);

      throw error;
    }
  }

  private hashPrompt(prompt: string): string {
    return createHash("sha256").update(prompt).digest("hex");
  }

  private parseCachedResult(cached: string): unknown {
    const parsed = JSON.parse(cached);

    if (typeof parsed !== "string") {
      return parsed;
    }

    try {
      return JSON.parse(parsed);
    } catch {
      return parsed;
    }
  }

  private serializeCacheResult(result: unknown): string {
    if (typeof result === "string") {
      try {
        JSON.parse(result);
        return result;
      } catch {
        return JSON.stringify(result);
      }
    }

    return JSON.stringify(result) ?? "null";
  }

  private async cacheResult(jobId: string, result: unknown): Promise<void> {
    if (!this.redisClient) return;

    try {
      const cacheKey = `${this.cacheKeyPrefix}${jobId}`;
      const resultStr = this.serializeCacheResult(result);

      // Store in Redis with TTL
      await this.redisClient.setex(
        cacheKey,
        Math.floor(GATEWAY_CONFIG.CACHE_TTL_MS / 1000), // Convert to seconds
        resultStr
      );
    } catch (error) {
      console.error("Cache storage error:", error);
    }
  }

  private cleanOldCache(): void {
    // Redis handles TTL automatically, no manual cleanup needed
  }
}
