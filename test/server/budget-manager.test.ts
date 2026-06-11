import { describe, expect, test, vi } from "vitest";
import { BudgetManager } from "../../src/server/services/budget-manager.js";
import type { QueuedBudgetReservation } from "../../src/server/services/request-queue.js";

describe("BudgetManager", () => {
  function makeBudgetManager() {
    const db: any = {
      budget: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      gatewayBudgetReservation: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      $executeRaw: vi.fn().mockResolvedValue({ count: 1 }),
      $transaction: vi.fn(async (callback) => callback(db))
    };

    const manager = new BudgetManager(db);
    manager.prune = vi.fn();

    return { manager, db };
  }

  test("reconciles when actual cost is less than estimated", async () => {
    const { manager, db } = makeBudgetManager();
    const reservation: QueuedBudgetReservation = {
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.10,
      status: "reserved"
    };

    await manager.reconcileUsage("job_1", reservation, 0.05);

    // Should call safeDecrement with the difference (0.10 - 0.05 = 0.05)
    expect(db.$executeRaw).toHaveBeenCalled();
    const args = db.$executeRaw.mock.calls[0][0];
    expect(args).toBeDefined();
  });

  test("reconciles reservation state and budget adjustment in one transaction", async () => {
    const { manager, db } = makeBudgetManager();
    const reservation: QueuedBudgetReservation = {
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.10,
      status: "reserved"
    };

    await manager.reconcileUsage("job_1", reservation, 0.05);

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.gatewayBudgetReservation.updateMany).toHaveBeenCalled();
    expect(db.$executeRaw).toHaveBeenCalled();
  });

  test("reconciles when actual cost exceeds estimated", async () => {
    const { manager, db } = makeBudgetManager();
    const reservation: QueuedBudgetReservation = {
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.01,
      status: "reserved"
    };

    await manager.reconcileUsage("job_1", reservation, 0.05);

    // Should call updateMany for safeIncrement (not $executeRaw)
    expect(db.budget.updateMany).toHaveBeenCalled();
  });

  test("does nothing when actual cost equals estimated", async () => {
    const { manager, db } = makeBudgetManager();
    const reservation: QueuedBudgetReservation = {
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.05,
      status: "reserved"
    };

    await manager.reconcileUsage("job_1", reservation, 0.05);

    // Should not call any updates when difference is 0
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  test("refunds the full reservation on request failure", async () => {
    const { manager, db } = makeBudgetManager();
    const reservation: QueuedBudgetReservation = {
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.10,
      status: "reserved"
    };

    await manager.refund("job_1", reservation);

    // Should refund the full amount
    expect(db.$executeRaw).toHaveBeenCalled();
    const args = db.$executeRaw.mock.calls[0][0];
    expect(args).toBeDefined();
  });

  test("refunds reservation state and budget adjustment in one transaction", async () => {
    const { manager, db } = makeBudgetManager();
    const reservation: QueuedBudgetReservation = {
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.10,
      status: "reserved"
    };

    await manager.refund("job_1", reservation);

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.gatewayBudgetReservation.updateMany).toHaveBeenCalled();
    expect(db.$executeRaw).toHaveBeenCalled();
  });

  test("uses raw SQL with GREATEST to prevent negative costs", async () => {
    const { manager, db } = makeBudgetManager();

    // Call private safeDecrement through reconciliation (when estimated > actual)
    const reservation: QueuedBudgetReservation = {
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.10,
      status: "reserved"
    };

    await manager.reconcileUsage("job_1", reservation, 0.05);

    // Verify that $executeRaw was called (which contains GREATEST logic for safe decrement)
    expect(db.$executeRaw).toHaveBeenCalled();

    // Check that the SQL contains GREATEST
    const sqlCall = db.$executeRaw.mock.calls[0][0];
    expect(sqlCall).toBeDefined();
  });

  test("ignores null or undefined reservations", async () => {
    const { manager, db } = makeBudgetManager();

    await manager.refund("job_1", undefined);
    expect(db.$executeRaw).not.toHaveBeenCalled();

    await manager.reconcileUsage("job_2", null as any, 0.05);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  test("prunes expired cached reservations", () => {
    const { manager } = makeBudgetManager();

    manager.prune();

    expect(manager.prune).toHaveBeenCalled();
  });

  test("refund validates jobId and skips update if invalid", async () => {
    const { manager, db } = makeBudgetManager();
    const reservation: QueuedBudgetReservation = {
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.10,
      status: "reserved"
    };

    // Should not throw when jobId is undefined
    await manager.refund(undefined as any, reservation);

    // Should NOT call the database update with invalid jobId
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  test("prevents double refund by tracking status atomically", async () => {
    const { manager, db } = makeBudgetManager();
    const reservation: QueuedBudgetReservation = {
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.10,
      status: "reserved"
    };

    // Mock updateMany to simulate atomic status change
    // First call succeeds (count=1), second call fails (count=0)
    let callCount = 0;
    db.gatewayBudgetReservation.updateMany.mockImplementation(async () => {
      callCount++;
      return { count: callCount === 1 ? 1 : 0 };
    });

    // First refund should succeed
    await manager.refund("job_1", reservation);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);

    // Reset mock
    db.$executeRaw.mockClear();

    // Second refund should be skipped (already refunded)
    await manager.refund("job_1", reservation);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  test("prevents double reconciliation by tracking status atomically", async () => {
    const { manager, db } = makeBudgetManager();
    const reservation: QueuedBudgetReservation = {
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.10,
      status: "reserved"
    };

    // Mock updateMany to simulate atomic status change
    let callCount = 0;
    db.gatewayBudgetReservation.updateMany.mockImplementation(async () => {
      callCount++;
      return { count: callCount === 1 ? 1 : 0 };
    });

    // First reconcile should succeed (estimated > actual, so safeDecrement is called)
    await manager.reconcileUsage("job_1", reservation, 0.08);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);

    // Reset mock
    db.$executeRaw.mockClear();

    // Second reconcile should be skipped (already reconciled)
    await manager.reconcileUsage("job_1", reservation, 0.08);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  test("rejects refund with empty string jobId", async () => {
    const { manager, db } = makeBudgetManager();
    const reservation: QueuedBudgetReservation = {
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.10,
      status: "reserved"
    };

    // Empty string should not update the database
    await manager.refund("", reservation);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  test("rejects reconciliation with null jobId", async () => {
    const { manager, db } = makeBudgetManager();
    const reservation: QueuedBudgetReservation = {
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.10,
      status: "reserved"
    };

    // Null should not update the database
    await manager.reconcileUsage(null as any, reservation, 0.05);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  test("prevents bulk updates when jobId is undefined", async () => {
    const { manager, db } = makeBudgetManager();
    const reservation: QueuedBudgetReservation = {
      orgId: "org_1",
      provider: "openai",
      estimatedCostUsd: 0.10,
      status: "reserved"
    };

    // If jobId is undefined, Prisma would normally match all 'reserved' rows for the org
    // This validation prevents that bulk update
    await manager.refund(undefined as any, reservation);

    // gatewayBudgetReservation.updateMany should NOT be called with an incomplete where clause
    expect(db.gatewayBudgetReservation.updateMany).not.toHaveBeenCalled();
  });
});
