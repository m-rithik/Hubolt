import type { QueuedBudgetReservation } from "./request-queue.js";

type BudgetDbClient = {
  budget: {
    updateMany: (args: any) => Promise<any>;
  };
  gatewayBudgetReservation: {
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  $executeRaw: (sql: any, ...values: any[]) => Promise<any>;
  $transaction?: <T>(callback: (tx: BudgetDbClient) => Promise<T>) => Promise<T>;
};

export interface BudgetReservationRecord {
  jobId: string;
  orgId: string;
  provider: string;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  reconciled: boolean;
  cachedAt: number;
}

const RESERVATION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class BudgetManager {
  private reservationCache = new Map<string, BudgetReservationRecord>();

  constructor(private db: BudgetDbClient) {}

  getCached(jobId: string): BudgetReservationRecord | undefined {
    const cached = this.reservationCache.get(jobId);
    if (cached && Date.now() - cached.cachedAt < RESERVATION_CACHE_TTL_MS) {
      return cached;
    }
    this.reservationCache.delete(jobId);
    return undefined;
  }

  cache(jobId: string, reservation: BudgetReservationRecord): void {
    this.reservationCache.set(jobId, reservation);
  }

  async reconcileUsage(
    jobId: string,
    queuedReservation: QueuedBudgetReservation,
    actualCostUsd: number
  ): Promise<void> {
    if (!queuedReservation) return;

    await this.withTransaction(async (tx) => {
      const reconciled = await this.atomicallyMarkReconciled(
        tx,
        jobId,
        queuedReservation.orgId,
        actualCostUsd
      );
      if (!reconciled) {
        return;
      }

      const difference = queuedReservation.estimatedCostUsd - actualCostUsd;

      if (difference > 0) {
        await this.safeDecrement(
          tx,
          queuedReservation.orgId,
          queuedReservation.provider,
          difference
        );
      } else if (difference < 0) {
        await this.safeIncrement(
          tx,
          queuedReservation.orgId,
          queuedReservation.provider,
          Math.abs(difference)
        );
      }
    });
  }

  private async atomicallyMarkReconciled(
    db: BudgetDbClient,
    jobId: string,
    orgId: string,
    actualCostUsd: number
  ): Promise<boolean> {
    // CRITICAL: Validate jobId is a non-empty string
    // If undefined/null, Prisma would match all rows with just orgId + status
    // causing unintended bulk updates of other jobs
    if (!jobId || typeof jobId !== "string" || jobId.trim() === "") {
      console.error(`Invalid jobId for reconciliation: ${jobId}`);
      return false;
    }

    try {
      const result = await db.gatewayBudgetReservation.updateMany({
        where: {
          jobId,
          orgId,
          status: "reserved"
        },
        data: {
          status: "reconciled",
          actualCostUsd,
          settledAt: new Date()
        }
      });

      return result.count > 0;
    } catch (error) {
      console.error(`Failed to atomically mark reconciliation for job ${jobId}:`, error);
      return false;
    }
  }

  async refund(jobId: string, queuedReservation: QueuedBudgetReservation | undefined): Promise<void> {
    if (!queuedReservation) return;

    await this.withTransaction(async (tx) => {
      const refunded = await this.atomicallyMarkRefunded(tx, jobId, queuedReservation.orgId);
      if (!refunded) {
        return;
      }

      await this.safeDecrement(
        tx,
        queuedReservation.orgId,
        queuedReservation.provider,
        queuedReservation.estimatedCostUsd
      );
    });
  }

  private async atomicallyMarkRefunded(
    db: BudgetDbClient,
    jobId: string,
    orgId: string
  ): Promise<boolean> {
    // CRITICAL: Validate jobId is a non-empty string
    // If undefined/null, Prisma would match all rows with just orgId + status
    // causing unintended bulk updates of other jobs
    if (!jobId || typeof jobId !== "string" || jobId.trim() === "") {
      console.error(`Invalid jobId for refund: ${jobId}`);
      return false;
    }

    try {
      const result = await db.gatewayBudgetReservation.updateMany({
        where: {
          jobId,
          orgId,
          status: "reserved"
        },
        data: {
          status: "refunded",
          settledAt: new Date()
        }
      });

      return result.count > 0;
    } catch (error) {
      console.error(`Failed to atomically mark refund for job ${jobId}:`, error);
      return false;
    }
  }

  private async safeDecrement(
    db: BudgetDbClient,
    orgId: string,
    provider: string,
    amount: number
  ): Promise<void> {
    if (amount <= 0) return;

    const refund = Math.min(amount, 999999999);
    const now = new Date();

    // Use raw SQL with GREATEST to prevent negative values
    // Matches the pattern used in BudgetService.refundUsage
    await db.$executeRaw`
      UPDATE "budgets"
      SET "currentMonthCostUsd" = GREATEST(0, "currentMonthCostUsd" - ${refund}),
          "updatedAt" = ${now}
      WHERE "orgId" = ${orgId}
        AND "provider" = ${provider}
    `;
  }

  private async safeIncrement(
    db: BudgetDbClient,
    orgId: string,
    provider: string,
    amount: number
  ): Promise<void> {
    if (amount <= 0) return;

    await db.budget.updateMany({
      where: {
        orgId,
        provider
      },
      data: {
        currentMonthCostUsd: {
          increment: Math.min(amount, 999999999)
        }
      }
    });
  }

  private async withTransaction<T>(operation: (db: BudgetDbClient) => Promise<T>): Promise<T> {
    if (typeof this.db.$transaction === "function") {
      return this.db.$transaction(operation);
    }

    return operation(this.db);
  }

  prune(): void {
    const now = Date.now();
    for (const [key, value] of this.reservationCache.entries()) {
      if (now - value.cachedAt > RESERVATION_CACHE_TTL_MS) {
        this.reservationCache.delete(key);
      }
    }
  }
}
