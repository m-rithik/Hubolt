import { afterEach, describe, expect, test, vi } from "vitest";
import { BudgetService } from "../../src/server/services/budget.js";

describe("BudgetService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("reserves usage with an atomic transaction", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{ requestCount: 1, maxRequestsPerDay: 1000 }]),
      auditEvent: { create: vi.fn() }
    };
    const transaction = vi.fn(async (callback: (txArg: any) => Promise<void>) => callback(tx));
    const service = new BudgetService({ $transaction: transaction } as any);

    await expect(service.reserveUsage("org_1", "google", "gemini-flash-latest", 0)).resolves.toEqual({
      allowed: true
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
  });

  test("rejects budget exhaustion before reserving rate limit capacity", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: "budget_1",
            currentMonthCostUsd: 10,
            monthlyLimitUsd: 10,
            alertThresholdPct: 80
          }
        ]),
      auditEvent: { create: vi.fn() }
    };
    const transaction = vi.fn(async (callback: (txArg: any) => Promise<void>) => callback(tx));
    const service = new BudgetService({ $transaction: transaction } as any);

    await expect(service.reserveUsage("org_1", "google", "gemini-flash-latest", 1)).resolves.toEqual({
      allowed: false,
      statusCode: 402,
      reason: "Budget exceeded for provider google"
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  test("rejects rate limit exhaustion", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValueOnce([
        {
          id: "budget_1",
          currentMonthCostUsd: 1,
          monthlyLimitUsd: 10,
          alertThresholdPct: 80
        }
      ]).mockResolvedValueOnce([]),
      auditEvent: { create: vi.fn() }
    };
    const transaction = vi.fn(async (callback: (txArg: any) => Promise<void>) => callback(tx));
    const service = new BudgetService({ $transaction: transaction } as any);

    await expect(service.reserveUsage("org_1", "google", "gemini-flash-latest", 1)).resolves.toEqual({
      allowed: false,
      statusCode: 429,
      reason: "Rate limit exceeded for google/gemini-flash-latest"
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  test("increments rate limits through one upsert", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const service = new BudgetService({
      rateLimitWindow: { upsert }
    } as any);

    await service.incrementRateLimit("org_1", "google", "gemini-flash-latest");

    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0][0]).toMatchObject({
      where: {
        orgId_provider_model_windowStart: {
          orgId: "org_1",
          provider: "google",
          model: "gemini-flash-latest"
        }
      },
      create: {
        orgId: "org_1",
        provider: "google",
        model: "gemini-flash-latest",
        requestCount: 1
      },
      update: {
        requestCount: { increment: 1 }
      }
    });
    expect(upsert.mock.calls[0][0].where.orgId_provider_model_windowStart.windowStart).toBeInstanceOf(Date);
    expect(upsert.mock.calls[0][0].create.windowStart).toBeInstanceOf(Date);
  });

  test("clamps refunded usage at zero in the database", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const service = new BudgetService({
      $executeRaw: executeRaw
    } as any);

    await service.refundUsage("org_1", "openai", 5);

    expect(executeRaw).toHaveBeenCalledOnce();
    expect(String(executeRaw.mock.calls[0][0])).toContain("GREATEST");
  });

  test("budget checks reset to the first day of the next UTC month", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-31T12:00:00Z"));

    const update = vi.fn().mockResolvedValue({
      id: "budget_1",
      currentMonthCostUsd: 0,
      monthlyLimitUsd: 100,
      alertThresholdPct: 80,
      currentMonthResets: new Date("2026-02-01T00:00:00Z")
    });
    const service = new BudgetService({
      budget: {
        findUnique: vi.fn().mockResolvedValue({
          id: "budget_1",
          currentMonthCostUsd: 20,
          monthlyLimitUsd: 100,
          alertThresholdPct: 80,
          currentMonthResets: new Date("2026-01-01T00:00:00Z")
        }),
        update
      }
    } as any);

    await service.checkBudget("org_1", "openai", 1);

    expect(update.mock.calls[0][0].data.currentMonthResets.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  test("manual monthly resets use the first day of the next UTC month", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-31T12:00:00Z"));

    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new BudgetService({
      budget: {
        updateMany
      }
    } as any);

    await service.resetMonthlyBudgets("org_1");

    expect(updateMany.mock.calls[0][0].data.currentMonthResets.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });
});
