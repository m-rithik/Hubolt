import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ServerContext } from "../app.js";
import { createAuthMiddleware, requireAdmin, isAuthenticated, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  listReviewProviders,
  getActiveReviewModel,
  setActiveReviewModel,
  isKnownReviewProvider,
  getActiveReviewThreshold,
  setActiveReviewThreshold,
  isValidSeverity,
  SEVERITY_LEVELS,
  type SeverityLevel
} from "../services/bitbucket-config.js";

const ReviewModelSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1, "Model id is required")
});

/**
 * Org-level review settings for the dashboard: the active LLM provider/model and
 * the severity threshold. Per-repository API tokens and webhook secrets are
 * managed via the named-integration routes, not here.
 */
export function registerBitbucketConfigRoutes(fastify: FastifyInstance, context: ServerContext): void {
  const authMiddleware = createAuthMiddleware(context.db);

  fastify.get(
    "/bitbucket/config",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      try {
        const activeModel = await getActiveReviewModel(context.db, request.orgId!);
        const activeThreshold = await getActiveReviewThreshold(context.db, request.orgId!);
        reply.send({
          webhookPath: "/webhooks/bitbucket",
          activeModel,
          providers: listReviewProviders(),
          activeThreshold: activeThreshold ?? null,
          severityLevels: SEVERITY_LEVELS
        });
      } catch (error) {
        request.log.error(error);
        reply.status(500).send({ error: "Failed to read review settings" });
      }
    }
  );

  // Set the active review provider/model. Unlike the gateway-gated GitHub route,
  // this accepts any known provider because the review runner uses the env key.
  fastify.put(
    "/bitbucket/config/model",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      if (!requireAdmin(request, reply)) {
        return;
      }
      try {
        const body = ReviewModelSchema.parse(request.body);
        if (!isKnownReviewProvider(body.provider)) {
          reply.status(400).send({ error: `Unknown provider "${body.provider}"` });
          return;
        }
        await setActiveReviewModel(context.db, request.orgId!, body.provider, body.model);
        const activeModel = await getActiveReviewModel(context.db, request.orgId!);
        reply.send({ activeModel, providers: listReviewProviders() });
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: error.errors[0]?.message ?? "Validation error" });
          return;
        }
        request.log.error(error);
        reply.status(500).send({ error: "Failed to set review model" });
      }
    }
  );

  // Set the severity threshold reviews report at or above.
  fastify.put(
    "/bitbucket/config/threshold",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      if (!requireAdmin(request, reply)) {
        return;
      }
      const level = (request.body as { level?: string } | undefined)?.level;
      if (!level || !isValidSeverity(level)) {
        reply.status(400).send({ error: `level must be one of: ${SEVERITY_LEVELS.join(", ")}` });
        return;
      }
      try {
        await setActiveReviewThreshold(context.db, request.orgId!, level as SeverityLevel);
        reply.send({ activeThreshold: level, severityLevels: SEVERITY_LEVELS });
      } catch (error) {
        request.log.error(error);
        reply.status(500).send({ error: "Failed to set severity threshold" });
      }
    }
  );
}
