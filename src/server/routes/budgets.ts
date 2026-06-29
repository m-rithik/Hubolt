import { FastifyInstance } from "fastify";
import { ServerContext } from "../app.js";
import { AuthenticatedRequest, createAuthMiddleware, isAuthenticated, requireAdmin } from "../middleware/auth.js";
import { BudgetService } from "../services/budget.js";
import { z } from "zod";

const CreateBudgetSchema = z.object({
  provider: z.string().min(1),
  monthlyLimitUsd: z.number().positive(),
  alertThresholdPct: z.number().int().min(1).max(100).default(80)
});

const UpdateBudgetSchema = z.object({
  monthlyLimitUsd: z.number().positive().optional(),
  alertThresholdPct: z.number().int().min(1).max(100).optional()
});

interface BudgetDTO {
  id: string;
  provider: string;
  monthlyLimitUsd: number;
  alertThresholdPct: number;
  currentMonthCostUsd: number;
  percentageUsed: number;
  createdAt: string;
  updatedAt: string;
}

export function registerBudgetRoutes(fastify: FastifyInstance, context: ServerContext): void {
  const authMiddleware = createAuthMiddleware(context.db);
  const budgetService = new BudgetService(context.db);

  fastify.get(
    "/budgets",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      if (!requireAdmin(request, reply)) {
        return;
      }

      try {
        const budgets = await context.db.budget.findMany({
          where: { orgId: request.orgId }
        });

        const dtos: BudgetDTO[] = budgets.map((b: any) => ({
          id: b.id,
          provider: b.provider,
          monthlyLimitUsd: b.monthlyLimitUsd,
          alertThresholdPct: b.alertThresholdPct,
          currentMonthCostUsd: b.currentMonthCostUsd,
          percentageUsed: b.monthlyLimitUsd > 0 ? (b.currentMonthCostUsd / b.monthlyLimitUsd) * 100 : 0,
          createdAt: b.createdAt.toISOString(),
          updatedAt: b.updatedAt.toISOString()
        }));

        reply.send({ budgets: dtos });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to fetch budgets" });
      }
    }
  );

  fastify.get(
    "/budgets/:provider",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      if (!requireAdmin(request, reply)) {
        return;
      }

      try {
        const { provider } = request.params as { provider: string };

        const budget = await context.db.budget.findUnique({
          where: { orgId_provider: { orgId: request.orgId!, provider } }
        });

        if (!budget) {
          reply.status(404).send({ error: "Budget not found" });
          return;
        }

        const dto: BudgetDTO = {
          id: budget.id,
          provider: budget.provider,
          monthlyLimitUsd: budget.monthlyLimitUsd,
          alertThresholdPct: budget.alertThresholdPct,
          currentMonthCostUsd: budget.currentMonthCostUsd,
          percentageUsed:
            budget.monthlyLimitUsd > 0
              ? (budget.currentMonthCostUsd / budget.monthlyLimitUsd) * 100
              : 0,
          createdAt: budget.createdAt.toISOString(),
          updatedAt: budget.updatedAt.toISOString()
        };

        reply.send(dto);
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to fetch budget" });
      }
    }
  );

  fastify.post<{ Body: z.infer<typeof CreateBudgetSchema> }>(
    "/budgets",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      if (!requireAdmin(request, reply)) {
        return;
      }

      try {
        const body = CreateBudgetSchema.parse(request.body);

        const now = new Date();
        const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

        const budget = await context.db.budget.upsert({
          where: { orgId_provider: { orgId: request.orgId!, provider: body.provider } },
          create: {
            orgId: request.orgId!,
            provider: body.provider,
            monthlyLimitUsd: body.monthlyLimitUsd,
            alertThresholdPct: body.alertThresholdPct,
            currentMonthResets: nextMonth
          },
          update: {
            monthlyLimitUsd: body.monthlyLimitUsd,
            alertThresholdPct: body.alertThresholdPct
          }
        });

        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "budget.created_or_updated",
            resource: "budget",
            resourceId: budget.id,
            details: JSON.stringify({
              provider: body.provider,
              monthlyLimitUsd: body.monthlyLimitUsd,
              alertThresholdPct: body.alertThresholdPct
            })
          }
        });

        const dto: BudgetDTO = {
          id: budget.id,
          provider: budget.provider,
          monthlyLimitUsd: budget.monthlyLimitUsd,
          alertThresholdPct: budget.alertThresholdPct,
          currentMonthCostUsd: budget.currentMonthCostUsd,
          percentageUsed:
            budget.monthlyLimitUsd > 0
              ? (budget.currentMonthCostUsd / budget.monthlyLimitUsd) * 100
              : 0,
          createdAt: budget.createdAt.toISOString(),
          updatedAt: budget.updatedAt.toISOString()
        };

        reply.status(201).send(dto);
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({
            error: "Invalid request body",
            details: error.errors
          });
          return;
        }

        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to create budget" });
      }
    }
  );

  fastify.patch<{ Body: z.infer<typeof UpdateBudgetSchema> }>(
    "/budgets/:provider",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      if (!requireAdmin(request, reply)) {
        return;
      }

      try {
        const { provider } = request.params as { provider: string };
        const body = UpdateBudgetSchema.parse(request.body);

        const budget = await context.db.budget.findUnique({
          where: { orgId_provider: { orgId: request.orgId!, provider } }
        });

        if (!budget) {
          reply.status(404).send({ error: "Budget not found" });
          return;
        }

        const updated = await context.db.budget.update({
          where: { id: budget.id },
          data: {
            monthlyLimitUsd: body.monthlyLimitUsd ?? budget.monthlyLimitUsd,
            alertThresholdPct: body.alertThresholdPct ?? budget.alertThresholdPct
          }
        });

        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "budget.updated",
            resource: "budget",
            resourceId: budget.id,
            details: JSON.stringify({
              provider,
              changes: body
            })
          }
        });

        const dto: BudgetDTO = {
          id: updated.id,
          provider: updated.provider,
          monthlyLimitUsd: updated.monthlyLimitUsd,
          alertThresholdPct: updated.alertThresholdPct,
          currentMonthCostUsd: updated.currentMonthCostUsd,
          percentageUsed:
            updated.monthlyLimitUsd > 0
              ? (updated.currentMonthCostUsd / updated.monthlyLimitUsd) * 100
              : 0,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString()
        };

        reply.send(dto);
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({
            error: "Invalid request body",
            details: error.errors
          });
          return;
        }

        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to update budget" });
      }
    }
  );

  fastify.delete(
    "/budgets/:provider",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      if (!requireAdmin(request, reply)) {
        return;
      }

      try {
        const { provider } = request.params as { provider: string };

        const budget = await context.db.budget.findUnique({
          where: { orgId_provider: { orgId: request.orgId!, provider } }
        });

        if (!budget) {
          reply.status(404).send({ error: "Budget not found" });
          return;
        }

        await context.db.budget.delete({
          where: { id: budget.id }
        });

        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "budget.deleted",
            resource: "budget",
            resourceId: budget.id,
            details: JSON.stringify({ provider })
          }
        });

        reply.send({ success: true });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to delete budget" });
      }
    }
  );
}
