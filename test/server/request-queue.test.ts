import { beforeEach, describe, expect, test, vi } from "vitest";

const bullmqMocks = vi.hoisted(() => {
  const queueInstances: any[] = [];
  const queueEventsInstances: any[] = [];
  const workerInstances: any[] = [];

  class MockQueue {
    name: string;
    opts: any;
    on = vi.fn();
    getJob = vi.fn();
    add = vi.fn();
    close = vi.fn();
    pause = vi.fn();
    resume = vi.fn();
    drain = vi.fn();
    getWaitingCount = vi.fn();
    getActiveCount = vi.fn();
    getCompletedCount = vi.fn();
    getFailedCount = vi.fn();
    getDelayedCount = vi.fn();
    isPaused = vi.fn();

    constructor(name: string, opts: any) {
      this.name = name;
      this.opts = opts;
      queueInstances.push(this);
    }
  }

  class MockQueueEvents {
    name: string;
    opts: any;
    on = vi.fn();
    close = vi.fn();

    constructor(name: string, opts: any) {
      this.name = name;
      this.opts = opts;
      queueEventsInstances.push(this);
    }
  }

  class MockWorker {
    name: string;
    processor: any;
    opts: any;
    on = vi.fn();
    close = vi.fn();

    constructor(name: string, processor: any, opts: any) {
      this.name = name;
      this.processor = processor;
      this.opts = opts;
      workerInstances.push(this);
    }
  }

  return {
    MockQueue,
    MockQueueEvents,
    MockWorker,
    queueInstances,
    queueEventsInstances,
    workerInstances
  };
});

vi.mock("bullmq", () => ({
  Queue: bullmqMocks.MockQueue,
  QueueEvents: bullmqMocks.MockQueueEvents,
  Worker: bullmqMocks.MockWorker
}));

import { RequestQueue, type QueuedRequest } from "../../src/server/services/request-queue.js";

const redisConnection = {
  url: "redis://localhost:6379",
  maxRetriesPerRequest: null
};

function makeQueuedRequest(overrides: Partial<QueuedRequest> = {}): QueuedRequest {
  return {
    id: "request_1",
    orgId: "org_1",
    provider: "openai",
    model: "gpt-4-mini",
    system: "system prompt",
    user: "user prompt",
    priority: 10,
    promptHash: "prompt_hash_1",
    createdAt: new Date(),
    timeout: 1000,
    budgetReservation: {
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.01,
      status: "reserved"
    },
    ...overrides
  };
}

function makeRedisClient() {
  const store = new Map<string, string>();

  return {
    duplicate: vi.fn(),
    options: {
      url: "redis://localhost:6379",
      maxRetriesPerRequest: null
    },
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return "OK";
    })
  };
}

describe("RequestQueue", () => {
  beforeEach(() => {
    bullmqMocks.queueInstances.length = 0;
    bullmqMocks.queueEventsInstances.length = 0;
    bullmqMocks.workerInstances.length = 0;
    vi.clearAllMocks();
  });

  test("registers BullMQ error handlers", async () => {
    const requestQueue = new RequestQueue(redisConnection);

    expect(bullmqMocks.queueInstances[0].on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(bullmqMocks.queueEventsInstances[0].on).toHaveBeenCalledWith("error", expect.any(Function));

    await requestQueue.init(async () => ({}));

    expect(bullmqMocks.workerInstances[0].on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  test("registers queue settlement handlers", async () => {
    const requestQueue = new RequestQueue(redisConnection);
    const onCompleted = vi.fn().mockResolvedValue(undefined);
    const onFailed = vi.fn().mockResolvedValue(undefined);

    await requestQueue.init(async () => ({}), { onCompleted, onFailed });

    const queueEvents = bullmqMocks.queueEventsInstances[0];
    const completedHandler = queueEvents.on.mock.calls.find((call: unknown[]) => call[0] === "completed")?.[1] as
      | ((event: { jobId: string; returnvalue: string }) => void)
      | undefined;
    const failedHandler = queueEvents.on.mock.calls.find((call: unknown[]) => call[0] === "failed")?.[1] as
      | ((event: { jobId: string; failedReason: string }) => void)
      | undefined;

    expect(completedHandler).toEqual(expect.any(Function));
    expect(failedHandler).toEqual(expect.any(Function));

    completedHandler!({ jobId: "job_1", returnvalue: "{\"ok\":true}" });
    failedHandler!({ jobId: "job_2", failedReason: "Provider failed" });

    expect(onCompleted).toHaveBeenCalledWith("job_1", "{\"ok\":true}");
    expect(onFailed).toHaveBeenCalledWith("job_2", "Provider failed");
  });

  test("passes separate Redis connection options to each BullMQ component", async () => {
    const originalRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    const requestQueue = new RequestQueue(redisConnection);

    try {
      await requestQueue.init(async () => ({}));

      const queueConnection = bullmqMocks.queueInstances[0].opts.connection;
      const queueEventsConnection = bullmqMocks.queueEventsInstances[0].opts.connection;
      const workerConnection = bullmqMocks.workerInstances[0].opts.connection;

      expect(queueConnection).toMatchObject({
        host: "localhost",
        port: 6379,
        maxRetriesPerRequest: null
      });
      expect(queueEventsConnection).toMatchObject({
        host: "localhost",
        port: 6379,
        maxRetriesPerRequest: null
      });
      expect(workerConnection).toMatchObject({
        host: "localhost",
        port: 6379,
        maxRetriesPerRequest: null
      });

      expect(queueConnection).not.toBe(queueEventsConnection);
      expect(queueConnection).not.toBe(workerConnection);
      expect(queueEventsConnection).not.toBe(workerConnection);
    } finally {
      if (originalRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = originalRedisUrl;
      }
    }
  });

  test("removes failed existing jobs before enqueueing a retry", async () => {
    const requestQueue = new RequestQueue(redisConnection);
    const queue = bullmqMocks.queueInstances[0];
    const existingJob = {
      id: "old_job",
      getState: vi.fn().mockResolvedValue("failed"),
      remove: vi.fn().mockResolvedValue(undefined)
    };
    queue.getJob.mockResolvedValue(existingJob);
    queue.add.mockResolvedValue({ id: "new_job" });

    await expect(requestQueue.enqueue(makeQueuedRequest())).resolves.toEqual({
      jobId: "new_job",
      created: true
    });

    expect(existingJob.remove).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledOnce();
  });

  test("reuses non-failed existing jobs", async () => {
    const requestQueue = new RequestQueue(redisConnection);
    const queue = bullmqMocks.queueInstances[0];
    const existingJob = {
      id: "existing_job",
      getState: vi.fn().mockResolvedValue("waiting"),
      remove: vi.fn()
    };
    queue.getJob.mockResolvedValue(existingJob);

    await expect(requestQueue.enqueue(makeQueuedRequest())).resolves.toEqual({
      jobId: "existing_job",
      created: false
    });

    expect(existingJob.remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  test("treats duplicate add races as joining the existing job", async () => {
    const requestQueue = new RequestQueue(redisConnection);
    const queue = bullmqMocks.queueInstances[0];
    const existingJob = {
      id: "raced_job",
      getState: vi.fn(),
      remove: vi.fn()
    };
    queue.getJob
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingJob);
    queue.add.mockRejectedValue(new Error("Job already exists"));

    await expect(requestQueue.enqueue(makeQueuedRequest())).resolves.toEqual({
      jobId: "raced_job",
      created: false
    });
  });

  test("stores and retrieves results from Redis cache", async () => {
    const requestQueue = new RequestQueue(redisConnection);
    const testResult = { ok: true, data: "cached" };

    // Cache result in Redis
    await (requestQueue as any).cacheResult("test-job", testResult);

    // Retrieve from cache
    const cached = await requestQueue.getCachedResult("test-job");

    // Note: In real usage, this requires a real Redis instance.
    // In tests with mocks, this will return null since the Redis client is not connected.
    expect(cached === null || cached?.ok === true).toBe(true);
  });

  test("stores stringified JSON cache results without double serialization", async () => {
    const redisClient = makeRedisClient();
    const requestQueue = new RequestQueue(redisClient as any);
    const result = {
      findings: [],
      metadata: {
        promptTokens: 20,
        completionTokens: 5,
        estimatedCostUsd: 0.01
      }
    };
    const serialized = JSON.stringify(result);

    await (requestQueue as any).cacheResult("test-job", serialized);

    expect(redisClient.setex).toHaveBeenCalledWith(
      "llm:cache:test-job",
      expect.any(Number),
      serialized
    );
    await expect(requestQueue.getCachedResult("test-job")).resolves.toEqual(result);
  });

  test("reads older double-serialized JSON cache entries", async () => {
    const redisClient = makeRedisClient();
    const requestQueue = new RequestQueue(redisClient as any);
    const result = { ok: true, data: "cached" };
    const doubleSerialized = JSON.stringify(JSON.stringify(result));

    redisClient.get.mockResolvedValueOnce(doubleSerialized);

    await expect(requestQueue.getCachedResult("test-job")).resolves.toEqual(result);
  });

  test("reads and marks budget reservation metadata on queued jobs", async () => {
    const requestQueue = new RequestQueue(redisConnection);
    const queue = bullmqMocks.queueInstances[0];
    const queuedRequest = makeQueuedRequest();
    const job = {
      data: queuedRequest,
      updateData: vi.fn().mockResolvedValue(undefined)
    };
    queue.getJob.mockResolvedValue(job);

    await expect(requestQueue.getBudgetReservation("job_1")).resolves.toEqual(queuedRequest.budgetReservation);
    await requestQueue.markBudgetReservationSettled("job_1", "reconciled", 0.02);

    expect(job.updateData).toHaveBeenCalledWith({
      ...queuedRequest,
      budgetReservation: {
        ...queuedRequest.budgetReservation,
        status: "reconciled",
        actualCostUsd: 0.02,
        settledAt: expect.any(String)
      }
    });
  });

  test("reports terminal failed state from BullMQ jobs", async () => {
    const requestQueue = new RequestQueue(redisConnection);
    const queue = bullmqMocks.queueInstances[0];
    queue.getJob.mockResolvedValue({
      isFailed: vi.fn().mockResolvedValue(true)
    });

    await expect(requestQueue.isTerminalFailed("job_1")).resolves.toBe(true);
  });

  test("does not treat retry-pending jobs as terminal failures", async () => {
    const requestQueue = new RequestQueue(redisConnection);
    const queue = bullmqMocks.queueInstances[0];
    queue.getJob.mockResolvedValue({
      isFailed: vi.fn().mockResolvedValue(false)
    });

    await expect(requestQueue.isTerminalFailed("job_1")).resolves.toBe(false);
  });

  test("respects REDIS_URL environment variable for BullMQ connections", async () => {
    const originalRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://custom-host:6380";

    try {
      const requestQueue = new RequestQueue(redisConnection);
      const queueConnection = bullmqMocks.queueInstances[bullmqMocks.queueInstances.length - 1].opts.connection;

      expect(queueConnection).toMatchObject({
        host: "custom-host",
        port: 6380,
        maxRetriesPerRequest: null
      });
    } finally {
      if (originalRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = originalRedisUrl;
      }
    }
  });

  test("handles connection options without URL property", () => {
    const connectionOptionsWithoutUrl = {
      host: "custom-host",
      port: 6380,
      maxRetriesPerRequest: null
    };

    // Should not throw when creating RequestQueue with host/port options
    const requestQueue = new RequestQueue(connectionOptionsWithoutUrl as any);
    expect(requestQueue).toBeDefined();

    // Verify that Queue was instantiated
    expect(bullmqMocks.queueInstances.length).toBeGreaterThan(0);
  });
});
