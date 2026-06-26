import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ServerContext } from "../app.js";
import { createAuthMiddleware, requireAdmin, isAuthenticated, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  getBitbucketConfigStatus,
  storeBitbucketField,
  clearBitbucketField,
  listReviewProviders,
  getActiveReviewModel,
  setActiveReviewModel,
  isKnownReviewProvider,
  type BitbucketField
} from "../services/bitbucket-config.js";

const ReviewModelSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1, "Model id is required")
});

// Tokens (ATCTT...) and webhook secrets are short but not tiny; require a
// minimum length to catch obvious paste mistakes without rejecting valid values.
const SaveSchema = z
  .object({
    apiToken: z.string().trim().min(10, "API token looks too short").optional(),
    webhookSecret: z.string().trim().min(8, "Webhook secret looks too short").optional()
  })
  .refine((body) => body.apiToken !== undefined || body.webhookSecret !== undefined, {
    message: "Provide an API token, a webhook secret, or both"
  });

/**
 * Dashboard configuration for the Bitbucket integration so the API token and
 * webhook secret can be set from the UI instead of editing .env. Values are
 * stored encrypted (CredentialManager); GET never returns them, only whether
 * each is configured and from where.
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
        const status = await getBitbucketConfigStatus(context.db, request.orgId!);
        const activeModel = await getActiveReviewModel(context.db, request.orgId!);
        reply.send({
          ...status,
          webhookPath: "/webhooks/bitbucket",
          activeModel,
          providers: listReviewProviders()
        });
      } catch (error) {
        request.log.error(error);
        reply.status(500).send({ error: "Failed to read Bitbucket configuration" });
      }
    }
  );

  fastify.post(
    "/bitbucket/config",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      if (!requireAdmin(request, reply)) {
        return;
      }
      try {
        const body = SaveSchema.parse(request.body);
        const orgId = request.orgId!;
        if (body.apiToken !== undefined) {
          await storeBitbucketField(context.db, orgId, "token", body.apiToken);
        }
        if (body.webhookSecret !== undefined) {
          await storeBitbucketField(context.db, orgId, "secret", body.webhookSecret);
        }
        const status = await getBitbucketConfigStatus(context.db, orgId);
        reply.status(201).send({ ...status, webhookPath: "/webhooks/bitbucket" });
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: error.errors[0]?.message ?? "Validation error" });
          return;
        }
        request.log.error(error);
        reply.status(500).send({ error: "Failed to save Bitbucket configuration" });
      }
    }
  );

  fastify.delete<{ Params: { field: string } }>(
    "/bitbucket/config/:field",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest & { params: { field: string } }, reply: FastifyReply) => {
      if (!requireAdmin(request, reply)) {
        return;
      }
      const field = request.params.field;
      if (field !== "token" && field !== "secret") {
        reply.status(400).send({ error: "Unknown field; use 'token' or 'secret'" });
        return;
      }
      try {
        await clearBitbucketField(context.db, request.orgId!, field as BitbucketField);
        const status = await getBitbucketConfigStatus(context.db, request.orgId!);
        reply.send({ ...status, webhookPath: "/webhooks/bitbucket" });
      } catch (error) {
        request.log.error(error);
        reply.status(500).send({ error: "Failed to clear Bitbucket configuration" });
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
}
