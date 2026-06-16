import { randomUUID } from "node:crypto";
import { PrismaClient } from "../../generated/prisma/index.js";
import { GATEWAY_CONFIG } from "./constants.js";

type BudgetDbClient = Pick<PrismaClient, "$executeRaw" | "budget" | "auditEvent">;

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  currentCost: number;
  monthlyLimit: number;
  percentageUsed: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  reason?: string;
  requestCount: number;
  maxRequests: number;
}

export interface UsageReservationResult {
  allowed: boolean;
  statusCode?: 402 | 429;
  reason?: string;
}

interface BudgetRow {
  id: string;
  currentMonthCostUsd: number;
  monthlyLimitUsd: number;
  alertThresholdPct: number;
}

interface RateLimitRow {
  requestCount: number;
  maxRequestsPerDay: number;
}

export class BudgetService {
  private lastWindowCleanupMs = 0;

  constructor(private db: PrismaClient) {}

  /**
   * Rate limit windows are one row per org/provider/model/day and would grow
   * without bound. Delete expired windows opportunistically, at most once an
   * hour per process, off the request path; failures only log.
   */
  private cleanupExpiredWindows(): void {
    const now = Date.now();
    if (now - this.lastWindowCleanupMs < 3600_000) {
      return;
    }
    this.lastWindowCleanupMs = now;

    // Best-effort housekeeping: it must never be able to fail a reservation,
    // including when constructed with a narrow client in tests.
    const deleteMany = (this.db as Partial<PrismaClient>).rateLimitWindow?.deleteMany;
    if (typeof deleteMany !== "function") {
      return;
    }

    const cutoff = new Date(now - GATEWAY_CONFIG.RATE_LIMIT_WINDOW_RETENTION_DAYS * 86400_000);
    void Promise.resolve(
      this.db.rateLimitWindow.deleteMany({ where: { windowStart: { lt: cutoff } } })
    ).catch((error: unknown) => {
      console.error("Rate limit window cleanup failed:", error);
    });
  }

  async reserveUsage(
    orgId: string,
    provider: string,
    model: string,
    estimatedCostUsd: number
  ): Promise<UsageReservationResult> {
    try {
      await this.db.$transaction(async (tx) => {
        const now = new Date();
        const dayStart = startOfUtcDay(now);

        if (estimatedCostUsd > 0) {
          const nextMonth = startOfNextUtcMonth(now);

          await tx.$executeRaw`
            UPDATE "budgets"
            SET "currentMonthCostUsd" = 0,
                "currentMonthResets" = ${nextMonth},
                "updatedAt" = ${now}
            WHERE "orgId" = ${orgId}
              AND "provider" = ${provider}
              AND "currentMonthResets" <= ${now}
          `;

          const budgetRows = await tx.$queryRaw<BudgetRow[]>`
            UPDATE "budgets"
            SET "currentMonthCostUsd" = "currentMonthCostUsd" + ${estimatedCostUsd},
                "updatedAt" = ${now}
            WHERE "orgId" = ${orgId}
              AND "provider" = ${provider}
              AND ("currentMonthCostUsd" + ${estimatedCostUsd}) <= "monthlyLimitUsd"
            RETURNING "id", "currentMonthCostUsd", "monthlyLimitUsd", "alertThresholdPct"
          `;

          if (budgetRows.length === 0) {
            const existingBudget = await tx.$queryRaw<BudgetRow[]>`
              SELECT "id", "currentMonthCostUsd", "monthlyLimitUsd", "alertThresholdPct"
              FROM "budgets"
              WHERE "orgId" = ${orgId}
                AND "provider" = ${provider}
              LIMIT 1
            `;

            if (existingBudget.length > 0) {
              throw new UsageLimitError({
                allowed: false,
                statusCode: 402,
                reason: `Budget exceeded for provider ${provider}`
              });
            }
          } else {
            const budget = budgetRows[0];
            if (
              budget.monthlyLimitUsd > 0 &&
              budget.currentMonthCostUsd > budget.monthlyLimitUsd * (budget.alertThresholdPct / 100)
            ) {
              await tx.auditEvent.create({
                data: {
                  orgId,
                  action: "budget.alert",
                  resource: "budget",
                  resourceId: budget.id,
                  details: JSON.stringify({
                    provider,
                    percentageUsed: (budget.currentMonthCostUsd / budget.monthlyLimitUsd) * 100,
                    currentCost: budget.currentMonthCostUsd,
                    limit: budget.monthlyLimitUsd
                  })
                }
              });
            }
          }
        }

        const rateLimitRows = await tx.$queryRaw<RateLimitRow[]>`
          INSERT INTO "rate_limit_windows"
            ("id", "orgId", "provider", "model", "windowStart", "requestCount", "maxRequestsPerDay")
          VALUES
            (${randomUUID()}, ${orgId}, ${provider}, ${model}, ${dayStart}, 1, ${GATEWAY_CONFIG.MAX_REQUESTS_PER_DAY})
          ON CONFLICT ("orgId", "provider", "model", "windowStart")
          DO UPDATE SET "requestCount" = "rate_limit_windows"."requestCount" + 1
          WHERE "rate_limit_windows"."requestCount" < "rate_limit_windows"."maxRequestsPerDay"
          RETURNING "requestCount", "maxRequestsPerDay"
        `;

        if (rateLimitRows.length === 0) {
          throw new UsageLimitError({
            allowed: false,
            statusCode: 429,
            reason: `Rate limit exceeded for ${provider}/${model}`
          });
        }
      });

      this.cleanupExpiredWindows();

      return { allowed: true };
    } catch (error) {
      if (error instanceof UsageLimitError) {
        return error.result;
      }
      throw error;
    }
  }

  async checkBudget(
    orgId: string,
    provider: string,
    estimatedCostUsd: number
  ): Promise<BudgetCheckResult> {
    let budget = await this.db.budget.findUnique({
      where: { orgId_provider: { orgId, provider } }
    });

    if (!budget) {
      return {
        allowed: true,
        currentCost: 0,
        monthlyLimit: 0,
        percentageUsed: 0
      };
    }

    const now = new Date();
    if (now >= budget.currentMonthResets) {
      const nextMonth = startOfNextUtcMonth(now);

      budget = await this.db.budget.update({
        where: { id: budget.id },
        data: {
          currentMonthCostUsd: 0,
          currentMonthResets: nextMonth
        }
      });
    }

    const totalCost = budget.currentMonthCostUsd + estimatedCostUsd;
    const percentageUsed = budget.monthlyLimitUsd > 0
      ? (totalCost / budget.monthlyLimitUsd) * 100
      : 0;

    if (totalCost > budget.monthlyLimitUsd) {
      return {
        allowed: false,
        reason: `Budget exceeded for provider ${provider}`,
        currentCost: budget.currentMonthCostUsd,
        monthlyLimit: budget.monthlyLimitUsd,
        percentageUsed
      };
    }

    return {
      allowed: true,
      currentCost: budget.currentMonthCostUsd,
      monthlyLimit: budget.monthlyLimitUsd,
      percentageUsed
    };
  }

  async deductBudget(
    orgId: string,
    provider: string,
    costUsd: number,
    db: BudgetDbClient = this.db
  ): Promise<void> {
    if (costUsd <= 0) {
      return;
    }

    const budget = await db.budget.findUnique({
      where: { orgId_provider: { orgId, provider } }
    });

    if (!budget) {
      return;
    }

    await db.budget.update({
      where: { orgId_provider: { orgId, provider } },
      data: { currentMonthCostUsd: { increment: costUsd } }
    });

    const updated = await db.budget.findUnique({
      where: { orgId_provider: { orgId, provider } }
    });

    if (
      updated &&
      updated.currentMonthCostUsd > budget.monthlyLimitUsd * (budget.alertThresholdPct / 100)
    ) {
      await db.auditEvent.create({
        data: {
          orgId,
          action: "budget.alert",
          resource: "budget",
          resourceId: budget.id,
          details: JSON.stringify({
            provider,
            percentageUsed: (updated.currentMonthCostUsd / budget.monthlyLimitUsd) * 100,
            currentCost: updated.currentMonthCostUsd,
            limit: budget.monthlyLimitUsd
          })
        }
      });
    }
  }

  async checkRateLimit(
    orgId: string,
    provider: string,
    model: string
  ): Promise<RateLimitCheckResult> {
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);

    const window = await this.db.rateLimitWindow.findUnique({
      where: {
        orgId_provider_model_windowStart: {
          orgId,
          provider,
          model,
          windowStart: dayStart
        }
      }
    });

    if (!window) {
      return {
        allowed: true,
        requestCount: 0,
        maxRequests: GATEWAY_CONFIG.MAX_REQUESTS_PER_DAY
      };
    }

    const maxRequests = window.maxRequestsPerDay;
    const nextCount = window.requestCount + 1;

    if (nextCount > maxRequests) {
      return {
        allowed: false,
        reason: `Rate limit exceeded for ${provider}/${model}`,
        requestCount: window.requestCount,
        maxRequests
      };
    }

    return {
      allowed: true,
      requestCount: window.requestCount,
      maxRequests
    };
  }

  async incrementRateLimit(
    orgId: string,
    provider: string,
    model: string
  ): Promise<void> {
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);

    await this.db.rateLimitWindow.upsert({
      where: {
        orgId_provider_model_windowStart: {
          orgId,
          provider,
          model,
          windowStart: dayStart
        }
      },
      create: {
        orgId,
        provider,
        model,
        windowStart: dayStart,
        requestCount: 1
      },
      update: { requestCount: { increment: 1 } }
    });
  }

  async refundUsage(
    orgId: string,
    provider: string,
    costUsd: number,
    db: Pick<PrismaClient, "$executeRaw"> = this.db
  ): Promise<void> {
    if (costUsd <= 0) return;

    const refund = Math.min(costUsd, 999999999);
    const now = new Date();

    await db.$executeRaw`
      UPDATE "budgets"
      SET "currentMonthCostUsd" = GREATEST(0, "currentMonthCostUsd" - ${refund}),
          "updatedAt" = ${now}
      WHERE "orgId" = ${orgId}
        AND "provider" = ${provider}
    `;
  }

  /**
   * Release a rate-limit slot that reserveUsage consumed when the request did
   * not actually call the provider (deduplicated onto another job, or failed
   * to enqueue). Without this, piggyback requests would burn a daily slot even
   * though they triggered no provider work. Clamped at zero; a no-op when the
   * window row is absent.
   */
  async refundRateLimit(
    orgId: string,
    provider: string,
    model: string,
    db: Pick<PrismaClient, "$executeRaw"> = this.db
  ): Promise<void> {
    const dayStart = startOfUtcDay(new Date());

    await db.$executeRaw`
      UPDATE "rate_limit_windows"
      SET "requestCount" = GREATEST(0, "requestCount" - 1)
      WHERE "orgId" = ${orgId}
        AND "provider" = ${provider}
        AND "model" = ${model}
        AND "windowStart" = ${dayStart}
    `;
  }

  async resetMonthlyBudgets(orgId: string): Promise<void> {
    const now = new Date();
    const nextMonth = startOfNextUtcMonth(now);

    await this.db.budget.updateMany({
      where: { orgId },
      data: {
        currentMonthCostUsd: 0,
        currentMonthResets: nextMonth
      }
    });
  }
}

class UsageLimitError extends Error {
  constructor(public result: UsageReservationResult) {
    super(result.reason);
  }
}

function startOfUtcDay(value: Date): Date {
  const dayStart = new Date(value);
  dayStart.setUTCHours(0, 0, 0, 0);
  return dayStart;
}

function startOfNextUtcMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
}
