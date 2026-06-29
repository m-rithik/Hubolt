import { FastifyInstance } from "fastify";
import { ServerContext } from "../app.js";
import { AuthenticatedRequest, createAuthMiddleware, isAuthenticated, requireAdmin } from "../middleware/auth.js";
import { z } from "zod";

const UpdateRateLimitSchema = z.object({
  maxRequestsPerDay: z.number().int().positive()
});

interface RateLimitWindowDTO {
  provider: string;
  model: string;
  requestCount: number;
  maxRequestsPerDay: number;
  windowStart: string;
}

export function registerRateLimitRoutes(fastify: FastifyInstance, context: ServerContext): void {
  const authMiddleware = createAuthMiddleware(context.db);

  fastify.get(
    "/rate-limits",
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
        const now = new Date();
        const dayStart = new Date(now);
        dayStart.setUTCHours(0, 0, 0, 0);

        const windows = await context.db.rateLimitWindow.findMany({
          where: {
            orgId: request.orgId,
            windowStart: dayStart
          }
        });

        const dtos: RateLimitWindowDTO[] = windows.map((w: any) => ({
          provider: w.provider,
          model: w.model,
          requestCount: w.requestCount,
          maxRequestsPerDay: w.maxRequestsPerDay,
          windowStart: w.windowStart.toISOString()
        }));

        reply.send({ rateLimits: dtos });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to fetch rate limits" });
      }
    }
  );

  fastify.get(
    "/rate-limits/:provider/:model",
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
        const { provider, model } = request.params as { provider: string; model: string };
        const now = new Date();
        const dayStart = new Date(now);
        dayStart.setUTCHours(0, 0, 0, 0);

        const window = await context.db.rateLimitWindow.findUnique({
          where: {
            orgId_provider_model_windowStart: {
              orgId: request.orgId!,
              provider,
              model,
              windowStart: dayStart
            }
          }
        });

        if (!window) {
          reply.send({
            provider,
            model,
            requestCount: 0,
            maxRequestsPerDay: 1000,
            windowStart: dayStart.toISOString()
          });
          return;
        }

        const dto: RateLimitWindowDTO = {
          provider: window.provider,
          model: window.model,
          requestCount: window.requestCount,
          maxRequestsPerDay: window.maxRequestsPerDay,
          windowStart: window.windowStart.toISOString()
        };

        reply.send(dto);
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to fetch rate limit" });
      }
    }
  );

  fastify.patch<{ Body: z.infer<typeof UpdateRateLimitSchema> }>(
    "/rate-limits/:provider/:model",
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
        const { provider, model } = request.params as { provider: string; model: string };
        const body = UpdateRateLimitSchema.parse(request.body);
        const now = new Date();
        const dayStart = new Date(now);
        dayStart.setUTCHours(0, 0, 0, 0);

        const window = await context.db.rateLimitWindow.upsert({
          where: {
            orgId_provider_model_windowStart: {
              orgId: request.orgId!,
              provider,
              model,
              windowStart: dayStart
            }
          },
          create: {
            orgId: request.orgId!,
            provider,
            model,
            windowStart: dayStart,
            maxRequestsPerDay: body.maxRequestsPerDay
          },
          update: {
            maxRequestsPerDay: body.maxRequestsPerDay
          }
        });

        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "rate_limit.updated",
            resource: "rate_limit",
            resourceId: window.id,
            details: JSON.stringify({
              provider,
              model,
              maxRequestsPerDay: body.maxRequestsPerDay
            })
          }
        });

        const dto: RateLimitWindowDTO = {
          provider: window.provider,
          model: window.model,
          requestCount: window.requestCount,
          maxRequestsPerDay: window.maxRequestsPerDay,
          windowStart: window.windowStart.toISOString()
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
        reply.status(500).send({ error: "Failed to update rate limit" });
      }
    }
  );
}
