-- CreateTable GatewayBudgetReservation
CREATE TABLE "gateway_budget_reservations" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "estimatedCostUsd" DOUBLE PRECISION NOT NULL,
    "actualCostUsd" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_budget_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gateway_budget_reservations_jobId_key" ON "gateway_budget_reservations"("jobId");

-- CreateIndex
CREATE INDEX "gateway_budget_reservations_orgId_idx" ON "gateway_budget_reservations"("orgId");

-- CreateIndex
CREATE INDEX "gateway_budget_reservations_status_idx" ON "gateway_budget_reservations"("status");
