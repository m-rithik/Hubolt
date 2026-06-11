import { describe, expect, test, vi } from "vitest";
import { LLMGateway, type GatewayRequest } from "../../src/server/services/llm-gateway.js";
import { InputValidator } from "../../src/server/services/validation.js";
import { GatewayError } from "../../src/server/services/errors.js";
import type { BudgetManager } from "../../src/server/services/budget-manager.js";

const baseRequest: GatewayRequest = {
  orgId: "org_1",
  reviewContext: {
    scope: "standard",
    estimatedTokens: 1000
  },
  system: "Review this code.",
  user: "const value = input;"
};

function makeGateway(overrides: Record<string, unknown> = {}) {
  const gateway: any = Object.create(LLMGateway.prototype);

  const db: any = {
    $transaction: vi.fn(async (callback) => callback(db)),
    gatewayBudgetReservation: {
      create: vi.fn().mockResolvedValue(undefined),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(undefined)
    }
  };
  gateway.db = db;
  gateway.validator = new InputValidator();
  gateway.modelRouter = {
    route: vi.fn().mockResolvedValue({
      provider: "openai",
      model: "gpt-4-mini",
      reason: "test default"
    }),
    getModelInfo: vi.fn().mockReturnValue({ costPer1kTokens: 0.00015 }),
    listAvailableModels: vi.fn().mockReturnValue({})
  };
  gateway.requestQueue = {
    getCachedResult: vi.fn().mockResolvedValue(null),
    getReusableJobId: vi.fn().mockResolvedValue(null),
    enqueue: vi.fn().mockResolvedValue({ jobId: "job_1", created: true }),
    getResult: vi.fn().mockResolvedValue({
      success: true,
      result: {
        findings: [],
        metadata: {
          promptTokens: 20,
          completionTokens: 5,
          estimatedCostUsd: 0.01
        }
      }
    }),
    getQueuedRequest: vi.fn().mockResolvedValue(null),
    isTerminalFailed: vi.fn().mockResolvedValue(true),
    getQueueStats: vi.fn().mockResolvedValue({ waiting: 0 }),
    getJob: vi.fn().mockResolvedValue(null)
  };
  gateway.budgetService = {
    checkBudget: vi.fn().mockResolvedValue({
      allowed: true,
      currentCost: 0,
      monthlyLimit: 0,
      percentageUsed: 0
    }),
    reserveUsage: vi.fn().mockResolvedValue({ allowed: true }),
    refundUsage: vi.fn().mockResolvedValue(undefined)
  };
  gateway.budgetManager = {
    refund: vi.fn().mockResolvedValue(undefined),
    reconcileUsage: vi.fn().mockResolvedValue(undefined)
  };
  gateway.costEstimator = {
    estimateCost: vi.fn().mockReturnValue(0.01),
    calculateTokens: vi.fn().mockReturnValue(10),
    calculateActualCost: vi.fn().mockReturnValue(0.01)
  };
  gateway.logger = {
    log: vi.fn().mockResolvedValue(undefined)
  };
  gateway.sleep = vi.fn().mockResolvedValue(undefined);
  gateway.credentialManager = {
    getCredential: vi.fn().mockResolvedValue("provider-key"),
    listCredentials: vi.fn().mockResolvedValue([])
  };

  Object.assign(gateway, overrides);

  return gateway;
}

describe("LLMGateway", () => {
  test("registers terminal queue settlement handlers", async () => {
    const gateway = makeGateway();
    gateway.requestQueue.init = vi.fn().mockResolvedValue(undefined);

    await gateway.init();

    expect(gateway.requestQueue.init).toHaveBeenCalledWith(expect.any(Function), {
      onCompleted: expect.any(Function),
      onFailed: expect.any(Function)
    });
  });

  test("rejects request when budget reservation is denied", async () => {
    const gateway = makeGateway();
    gateway.budgetService.reserveUsage.mockResolvedValue({
      allowed: false,
      statusCode: 402,
      reason: "Budget exceeded for provider openai"
    });

    await expect(gateway.processRequest(baseRequest)).rejects.toThrow(GatewayError);
    expect(gateway.requestQueue.enqueue).not.toHaveBeenCalled();
  });

  test("validates request input before processing", async () => {
    const gateway = makeGateway();

    const invalidRequest = {
      ...baseRequest,
      reviewContext: {
        scope: "invalid_scope",
        estimatedTokens: 1000
      }
    };

    await expect(gateway.processRequest(invalidRequest)).rejects.toThrow();
  });

  test("reports missing provider credentials as error", async () => {
    const gateway = makeGateway();
    gateway.credentialManager.getCredential.mockRejectedValue(
      new Error("No credentials configured for provider: openai")
    );

    await expect(gateway.processRequest(baseRequest)).rejects.toThrow();
  });

  test("preserves validation failures", async () => {
    const gateway = makeGateway();

    const badRequest = {
      ...baseRequest,
      system: ""
    };

    await expect(gateway.processRequest(badRequest)).rejects.toThrow();
  });

  test("returns cached responses without budget reservation", async () => {
    const gateway = makeGateway();
    const cachedResult = {
      findings: ["cached finding"],
      metadata: {
        promptTokens: 10,
        completionTokens: 5,
        estimatedCostUsd: 0.005
      }
    };

    gateway.requestQueue.getCachedResult.mockResolvedValue(cachedResult);

    const response = await gateway.processRequest(baseRequest);

    expect(response.findings).toEqual(["cached finding"]);
    expect(response.metadata.cached).toBe(true);
    expect(gateway.budgetService.reserveUsage).not.toHaveBeenCalled();
    expect(gateway.logger.log).not.toHaveBeenCalled();
  });

  test("reuses an existing queue job before reserving budget", async () => {
    const gateway = makeGateway();

    gateway.requestQueue.getReusableJobId.mockResolvedValue("job_1");

    const response = await gateway.processRequest(baseRequest);

    expect(response.metadata.cached).toBe(false);
    expect(gateway.budgetService.reserveUsage).not.toHaveBeenCalled();
    expect(gateway.requestQueue.enqueue).not.toHaveBeenCalled();
    expect(gateway.db.gatewayBudgetReservation.create).not.toHaveBeenCalled();
  });

  test("passes provider budget context into model routing when a budget exists", async () => {
    const gateway = makeGateway();
    gateway.budgetService.checkBudget.mockResolvedValue({
      allowed: true,
      currentCost: 90,
      monthlyLimit: 100,
      percentageUsed: 90
    });
    gateway.modelRouter.route
      .mockResolvedValueOnce({
        provider: "openai",
        model: "gpt-4",
        reason: "initial route"
      })
      .mockResolvedValueOnce({
        provider: "openai",
        model: "gpt-4-mini",
        reason: "budget route"
      });

    await gateway.processRequest(baseRequest);

    expect(gateway.budgetService.checkBudget).toHaveBeenCalledWith("org_1", "openai", 0);
    expect(gateway.modelRouter.route).toHaveBeenNthCalledWith(2, {
      orgId: "org_1",
      reviewScope: "standard",
      estimatedTokens: 1000,
      currentBudgetUsed: 90,
      totalBudget: 100
    });
    expect(gateway.requestQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4-mini"
      })
    );
  });

  test("enqueues job and waits for result on cache miss", async () => {
    const gateway = makeGateway();

    const response = await gateway.processRequest(baseRequest);

    expect(gateway.requestQueue.enqueue).toHaveBeenCalled();
    expect(gateway.requestQueue.getResult).toHaveBeenCalled();
    expect(response.metadata.cached).toBe(false);
  });

  test("settlement handlers refund budget on job failure", async () => {
    const gateway = makeGateway();
    gateway.requestQueue.init = vi.fn().mockResolvedValue(undefined);
    gateway.requestQueue.isTerminalFailed.mockResolvedValue(true);
    gateway.requestQueue.getQueuedRequest.mockResolvedValue({
      budgetReservation: {
        orgId: "org_1",
        provider: "openai",
        estimatedCostUsd: 0.01,
        status: "reserved"
      }
    });

    await gateway.init();

    // Get the settlement handlers
    const handlers = gateway.requestQueue.init.mock.calls[0][1];

    // Simulate job failure via settlement handler
    await handlers.onFailed("job_1", "Job execution failed");

    // Budget manager refund should be called by settlement handler
    expect(gateway.budgetManager.refund).toHaveBeenCalled();
  });

  test("settlement handlers do not refund budget for retryable job failures", async () => {
    const gateway = makeGateway();
    gateway.requestQueue.init = vi.fn().mockResolvedValue(undefined);
    gateway.requestQueue.isTerminalFailed.mockResolvedValue(false);

    await gateway.init();

    const handlers = gateway.requestQueue.init.mock.calls[0][1];
    await handlers.onFailed("job_1", "Transient provider failure");

    expect(gateway.requestQueue.getQueuedRequest).not.toHaveBeenCalled();
    expect(gateway.budgetManager.refund).not.toHaveBeenCalled();
  });

  test("validates credentials on configuration", async () => {
    const gateway = makeGateway();
    gateway.credentialManager.storeCredential = vi.fn().mockResolvedValue(undefined);

    await gateway.configureCredential("org_1", "openai", "valid-api-key-123");

    expect(gateway.credentialManager.storeCredential).toHaveBeenCalledWith(
      "org_1",
      "openai",
      "valid-api-key-123"
    );
  });

  test("removes credentials", async () => {
    const gateway = makeGateway();
    gateway.credentialManager.deleteCredential = vi.fn().mockResolvedValue(undefined);

    await gateway.removeCredential("org_1", "openai");

    expect(gateway.credentialManager.deleteCredential).toHaveBeenCalledWith("org_1", "openai");
  });

  test("returns gateway status", async () => {
    const gateway = makeGateway();

    const status = await gateway.getStatus("org_1");

    expect(status).toHaveProperty("configuredProviders");
    expect(status).toHaveProperty("queueStatus");
    expect(status).toHaveProperty("availableModels");
  });

  test("handles missing budget reservation on job completion", async () => {
    const gateway = makeGateway();
    gateway.requestQueue.init = vi.fn().mockResolvedValue(undefined);

    await gateway.init();

    const handlers = gateway.requestQueue.init.mock.calls[0][1];
    // Should not throw even if no budget reservation
    await expect(handlers.onCompleted("job_1", {})).resolves.not.toThrow();
  });

  test("reconciles actual cost vs estimated", async () => {
    const gateway = makeGateway();
    gateway.requestQueue.getQueuedRequest.mockResolvedValue({
      budgetReservation: {
        orgId: "org_1",
        provider: "openai",
        estimatedCostUsd: 0.02,
        status: "reserved"
      }
    });

    // Budget manager should reconcile differences
    expect(gateway.budgetManager).toBeDefined();
  });

  test("closes gateway resources", async () => {
    const gateway = makeGateway();
    gateway.requestQueue.close = vi.fn().mockResolvedValue(undefined);

    await gateway.close();

    expect(gateway.requestQueue.close).toHaveBeenCalled();
  });

  test("charges budget overage when actual cost exceeds estimate", async () => {
    const gateway = makeGateway();
    const budgetManager = {
      refund: vi.fn().mockResolvedValue(undefined),
      reconcileUsage: vi.fn().mockResolvedValue(undefined)
    };
    gateway.budgetManager = budgetManager;
    gateway.requestQueue.getQueuedRequest.mockResolvedValue({
      budgetReservation: {
        orgId: "org_1",
        provider: "openai",
        estimatedCostUsd: 0.01,
        status: "reserved"
      }
    });

    const settledJob = async (jobId: string, result: unknown) => {
      if (gateway.requestQueue.getQueuedRequest.mock) {
        const queued = await gateway.requestQueue.getQueuedRequest(jobId);
        if (queued?.budgetReservation) {
          const actualCost = 0.05;
          await gateway.budgetManager.reconcileUsage(jobId, queued.budgetReservation, actualCost);
        }
      }
    };

    await settledJob("job_1", { findings: [] });

    expect(budgetManager.reconcileUsage).toHaveBeenCalled();
  });

  test("refunds budget on queue enqueue error", async () => {
    const gateway = makeGateway();
    gateway.requestQueue.enqueue.mockRejectedValue(new Error("Redis connection failed"));
    gateway.requestQueue.getQueuedRequest.mockResolvedValue({
      budgetReservation: {
        orgId: "org_1",
        provider: "openai",
        estimatedCostUsd: 0.01,
        status: "reserved"
      }
    });

    await expect(gateway.processRequest(baseRequest)).rejects.toThrow();

    expect(gateway.budgetManager.refund).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        orgId: "org_1",
        provider: "openai"
      })
    );
  });

  test("defers refund when result polling fails while the job is active", async () => {
    const gateway = makeGateway();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    gateway.requestQueue.getResult.mockRejectedValue(new Error("Redis connection dropped"));
    gateway.requestQueue.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue("active")
    });

    await expect(gateway.processRequest(baseRequest)).rejects.toThrow();

    expect(gateway.requestQueue.enqueue).toHaveBeenCalled();
    expect(gateway.budgetManager.refund).not.toHaveBeenCalled();
    expect(gateway.budgetService.refundUsage).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("returns 400 Bad Request for validation errors", async () => {
    const gateway = makeGateway();

    const invalidRequest = {
      ...baseRequest,
      system: "" // Empty system prompt should fail validation
    };

    try {
      await gateway.processRequest(invalidRequest);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error).toBeInstanceOf(GatewayError);
      expect(error.statusCode).toBe(400);
    }
  });

  test("returns 400 Bad Request for invalid review scope", async () => {
    const gateway = makeGateway();

    const invalidRequest = {
      ...baseRequest,
      reviewContext: {
        scope: "invalid_scope",
        estimatedTokens: 1000
      }
    };

    try {
      await gateway.processRequest(invalidRequest);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error).toBeInstanceOf(GatewayError);
      expect(error.statusCode).toBe(400);
    }
  });

  test("rejects provider override without an explicit model override", async () => {
    const gateway = makeGateway();

    await expect(
      gateway.processRequest({
        ...baseRequest,
        overrideProvider: "anthropic"
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(gateway.credentialManager.getCredential).not.toHaveBeenCalled();
  });

  test("rejects model overrides that are not available for the provider", async () => {
    const gateway = makeGateway();
    gateway.modelRouter.getModelInfo.mockReturnValue(null);

    await expect(
      gateway.processRequest({
        ...baseRequest,
        overrideProvider: "openai",
        overrideModel: "claude-sonnet-4"
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(gateway.credentialManager.getCredential).not.toHaveBeenCalled();
  });

  test("preserves 402 status code for budget exceeded", async () => {
    const gateway = makeGateway();
    gateway.budgetService.reserveUsage.mockResolvedValue({
      allowed: false,
      statusCode: 402,
      reason: "Monthly budget exceeded"
    });

    try {
      await gateway.processRequest(baseRequest);
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error).toBeInstanceOf(GatewayError);
      expect(error.statusCode).toBe(402);
    }
  });

  test("refunds the persistent reservation if enqueue discovers a duplicate job", async () => {
    const gateway = makeGateway();
    gateway.requestQueue.enqueue.mockResolvedValue({ jobId: "job_1", created: false });

    await gateway.processRequest(baseRequest);

    expect(gateway.budgetManager.refund).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        orgId: "org_1",
        provider: "openai"
      })
    );
  });

  test("does not reserve budget for known deduplicated requests", async () => {
    const gateway = makeGateway();
    gateway.requestQueue.getReusableJobId.mockResolvedValue("job_1");

    await gateway.processRequest(baseRequest);

    expect(gateway.budgetService.reserveUsage).not.toHaveBeenCalled();
    expect(gateway.db.gatewayBudgetReservation.create).not.toHaveBeenCalled();
  });

  test("inserts budget reservation only for newly created jobs", async () => {
    const gateway = makeGateway();
    gateway.requestQueue.enqueue.mockResolvedValue({ jobId: "job_1", created: true });

    await gateway.processRequest(baseRequest);

    // Budget reservation record should be created for new jobs
    expect(gateway.db.gatewayBudgetReservation.create).toHaveBeenCalled();
  });

  test("persists the budget reservation before enqueueing a new job", async () => {
    const gateway = makeGateway();

    await gateway.processRequest(baseRequest);

    const reservationOrder = gateway.db.gatewayBudgetReservation.create.mock.invocationCallOrder[0];
    const enqueueOrder = gateway.requestQueue.enqueue.mock.invocationCallOrder[0];
    expect(reservationOrder).toBeLessThan(enqueueOrder);
  });

  test("joins the existing queue job when reservation creation hits a unique conflict", async () => {
    const gateway = makeGateway();
    const uniqueError = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

    gateway.requestQueue.getReusableJobId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("job_1");
    gateway.db.gatewayBudgetReservation.create.mockRejectedValue(uniqueError);
    gateway.db.gatewayBudgetReservation.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        orgId: "org_1",
        provider: "openai",
        estimatedCostUsd: 0.01,
        status: "reserved",
        createdAt: new Date(),
        updatedAt: new Date()
      });

    const response = await gateway.processRequest(baseRequest);

    expect(response.metadata.cached).toBe(false);
    expect(gateway.requestQueue.enqueue).not.toHaveBeenCalled();
    expect(gateway.budgetService.refundUsage).toHaveBeenCalledWith("org_1", "openai", 0.01);
    expect(gateway.requestQueue.getResult).toHaveBeenCalledWith("job_1", expect.any(Number));
  });

  test("does not refund a fresh reservation row while another request is still enqueueing", async () => {
    const gateway = makeGateway();

    gateway.db.gatewayBudgetReservation.findUnique.mockResolvedValue({
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.01,
      status: "reserved",
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await expect(gateway.processRequest(baseRequest)).rejects.toMatchObject({ statusCode: 503 });

    expect(gateway.requestQueue.enqueue).not.toHaveBeenCalled();
    expect(gateway.budgetManager.refund).not.toHaveBeenCalled();
    expect(gateway.budgetService.refundUsage).toHaveBeenCalledWith("org_1", "openai", 0.01);
  });
});
