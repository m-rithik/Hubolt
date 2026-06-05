import { describe, expect, test, vi } from "vitest";
import { BudgetService } from "../../src/server/services/budget.js";

describe("BudgetService", () => {
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
});
