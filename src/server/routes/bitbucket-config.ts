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
import { runBitbucketReview } from "../services/bitbucket-review.js";
import { resolveIntegrationByRepoFullName } from "../services/repository-integrations.js";

const ReviewModelSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1, "Model id is required")
});

const TriggerReviewSchema = z
  .object({
    repoId: z.string().trim().min(1).optional(),
    repoFullName: z
      .string()
      .trim()
      .regex(/^[\w.-]+\/[\w.-]+$/, "Use workspace/repo format, e.g. acme/payments")
      .optional(),
    prNumber: z.coerce.number().int().positive("PR number must be positive")
  })
  .refine((body) => body.repoId || body.repoFullName, {
    message: "repoId or repoFullName is required"
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
          triggerPath: "/bitbucket/trigger",
          activeModel,
          providers: await listReviewProviders(context.db, request.orgId!),
          activeThreshold: activeThreshold ?? null,
          severityLevels: SEVERITY_LEVELS
        });
      } catch (error) {
        request.log.error(error);
        reply.status(500).send({ error: "Failed to read review settings" });
      }
    }
  );

  // Set the active review provider/model. Bitbucket reviews use the same
  // gateway-stored provider keys as GitHub reviews.
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
        const providers = await listReviewProviders(context.db, request.orgId!);
        if (!providers.some((entry) => entry.id === body.provider)) {
          reply.status(400).send({
            error: `No gateway credential for "${body.provider}". Add its API key in the Gateway tab first.`
          });
          return;
        }
        await setActiveReviewModel(context.db, request.orgId!, body.provider, body.model);
        const activeModel = await getActiveReviewModel(context.db, request.orgId!);
        reply.send({ activeModel, providers: await listReviewProviders(context.db, request.orgId!) });
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

  // Admin-only manual trigger for testing a stored Bitbucket integration without
  // waiting for Bitbucket Cloud to redeliver a webhook.
  fastify.post(
    "/bitbucket/trigger",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      if (!requireAdmin(request, reply)) {
        return;
      }

      let body: z.infer<typeof TriggerReviewSchema>;
      try {
        body = TriggerReviewSchema.parse(request.body);
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: error.errors[0]?.message ?? "Validation error" });
          return;
        }
        throw error;
      }

      try {
        const repo = await context.db.repository.findFirst({
          where: {
            orgId: request.orgId!,
            disabledAt: null,
            ...(body.repoId ? { id: body.repoId } : { fullName: body.repoFullName })
          },
          select: { id: true, fullName: true }
        });
        if (!repo) {
          reply.status(404).send({ error: "Repository not found in this organization" });
          return;
        }

        const integration = await resolveIntegrationByRepoFullName(context.db, request.orgId!, repo.fullName);
        if (!integration) {
          reply.status(404).send({ error: "No Bitbucket integration configured for this repository" });
          return;
        }

        void runBitbucketReview(context.db, {
          orgId: request.orgId!,
          repoId: repo.id,
          repoFullName: repo.fullName,
          prNumber: body.prNumber,
          action: "manual:test-trigger",
          token: integration.token,
          slackWebhookUrl: integration.slackWebhookUrl
        })
          .then((outcome) => {
            request.log.info(
              { repo: repo.fullName, prNumber: body.prNumber, status: outcome.status },
              "Bitbucket test trigger finished"
            );
          })
          .catch((error) => {
            request.log.error({ err: error, repo: repo.fullName, prNumber: body.prNumber }, "Bitbucket test trigger failed");
          });

        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "bitbucket.review_triggered",
            resource: "repository",
            resourceId: repo.id,
            details: JSON.stringify({ repo: repo.fullName, prNumber: body.prNumber })
          }
        });

        reply.status(202).send({ processed: true, repository: repo.fullName, prNumber: body.prNumber });
      } catch (error) {
        request.log.error(error);
        reply.status(500).send({ error: "Failed to trigger Bitbucket review" });
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
