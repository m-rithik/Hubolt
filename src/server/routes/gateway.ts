import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/index.js";
import { LLMGateway } from "../services/llm-gateway.js";
import { MODEL_CATALOG } from "../services/model-catalog.js";
import { isGatewayError, getErrorStatusCode, getErrorMessage } from "../services/errors.js";
import { ValidationError } from "../services/validation.js";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";

const ConfigureCredentialSchema = z.object({
  provider: z.enum(["anthropic", "openai", "google"]),
  apiKey: z.string().min(10, "API key must be at least 10 characters")
});

const ProcessRequestSchema = z.object({
  reviewContext: z.object({
    scope: z.enum(["security", "standard", "all"]).default("standard"),
    estimatedTokens: z.number().optional()
  }),
  system: z.string().min(1, "System prompt is required"),
  user: z.string().min(1, "User prompt is required"),
  overrideProvider: z.enum(["anthropic", "openai", "google"]).optional(),
  overrideModel: z.string().optional()
});

export async function registerGatewayRoutes(
  fastify: FastifyInstance,
  gateway: LLMGateway,
  db: PrismaClient
): Promise<void> {
  const authMiddleware = createAuthMiddleware(db);

  fastify.post<{ Body: typeof ConfigureCredentialSchema._type }>(
    "/gateway/credentials",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      try {
        const body = ConfigureCredentialSchema.parse(request.body);
        const orgId = request.orgId!;

        await gateway.configureCredential(orgId, body.provider, body.apiKey);

        reply.status(201).send({
          success: true,
          message: `Credentials configured for ${body.provider}`
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({
            success: false,
            message: "Validation error",
            errors: error.errors
          });
          return;
        }

        const statusCode = error instanceof ValidationError ? 400 : getErrorStatusCode(error);
        const message = statusCode === 500 ? "Failed to configure credentials" : getErrorMessage(error);

        fastify.log.error({ error, statusCode });
        reply.status(statusCode).send({
          success: false,
          message
        });
      }
    }
  );

  fastify.delete<{ Params: { provider: string } }>(
    "/gateway/credentials/:provider",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest & { params: { provider: string } }, reply: FastifyReply) => {
      try {
        const orgId = request.orgId!;
        const provider = request.params.provider;

        if (!["anthropic", "openai", "google"].includes(provider)) {
          reply.status(400).send({
            success: false,
            message: "Invalid provider"
          });
          return;
        }

        await gateway.removeCredential(orgId, provider);

        reply.send({
          success: true,
          message: `Credentials removed for ${provider}`
        });
      } catch (error) {
        const statusCode = error instanceof ValidationError ? 400 : getErrorStatusCode(error);
        const message = statusCode === 500 ? "Failed to remove credentials" : getErrorMessage(error);

        fastify.log.error({ error, statusCode });
        reply.status(statusCode).send({
          success: false,
          message
        });
      }
    }
  );

  fastify.get(
    "/gateway/status",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      try {
        const orgId = request.orgId!;
        const status = await gateway.getStatus(orgId);

        reply.send({
          success: true,
          status
        });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({
          success: false,
          message: "Failed to get gateway status"
        });
      }
    }
  );

  fastify.post<{ Body: typeof ProcessRequestSchema._type }>(
    "/gateway/complete",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      try {
        const body = ProcessRequestSchema.parse(request.body);
        const orgId = request.orgId!;

        const response = await gateway.processRequest({
          orgId,
          reviewContext: body.reviewContext,
          system: body.system,
          user: body.user,
          overrideProvider: body.overrideProvider,
          overrideModel: body.overrideModel
        });

        reply.send({
          success: true,
          data: response
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({
            success: false,
            message: "Validation error",
            errors: error.errors
          });
          return;
        }

        const statusCode = isGatewayError(error) ? error.statusCode : getErrorStatusCode(error);
        const errorMessage = getErrorMessage(error);

        fastify.log.error({ error, statusCode });
        reply.status(statusCode).send({
          success: false,
          message: errorMessage
        });
      }
    }
  );

  fastify.get(
    "/gateway/models",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      try {
        const models = Object.fromEntries(
          Object.entries(MODEL_CATALOG).map(([provider, providerModels]) => [
            provider,
            {
              models: Object.entries(providerModels)
                .filter(([, info]) => info.available)
                .map(([id, info]) => ({
                  id,
                  name: info.displayName,
                  costPer1kTokens: info.costPer1kTokens,
                  quality: info.quality,
                  latency: info.latency
                }))
            }
          ])
        );

        reply.send({
          success: true,
          models
        });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({
          success: false,
          message: "Failed to get models"
        });
      }
    }
  );
}
