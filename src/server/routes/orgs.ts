import { FastifyInstance } from "fastify";
import { ServerContext } from "../app.js";
import { generateApiKey, hashApiKey } from "../api-keys.js";
import { AuthenticatedRequest, createAuthMiddleware, isAuthenticated } from "../middleware/auth.js";
import { z } from "zod";

const CreateApiKeySchema = z.object({
  name: z.string().min(1)
});

export function registerOrgRoutes(fastify: FastifyInstance, context: ServerContext): void {
  const authMiddleware = createAuthMiddleware(context.db);

  fastify.get(
    "/orgs/current",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      try {
        const org = await context.db.organization.findUnique({
          where: { id: request.orgId! },
          include: {
            members: {
              include: { user: true }
            },
            apiKeys: {
              select: { id: true, name: true, createdAt: true, expiresAt: true, lastUsedAt: true }
            }
          }
        });

        if (!org) {
          reply.status(404).send({ error: "Organization not found" });
          return;
        }

        reply.send({
          id: org.id,
          name: org.name,
          slug: org.slug,
          members: org.members.map((m: any) => ({
            id: m.id,
            email: m.user.email,
            name: m.user.name,
            role: m.role
          })),
          apiKeys: org.apiKeys.map((k: any) => ({
            id: k.id,
            name: k.name,
            createdAt: k.createdAt.toISOString(),
            expiresAt: k.expiresAt?.toISOString() || null,
            lastUsedAt: k.lastUsedAt?.toISOString() || null
          }))
        });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to fetch organization" });
      }
    }
  );

  fastify.post<{ Body: z.infer<typeof CreateApiKeySchema> }>(
    "/orgs/current/api-keys",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      try {
        const body = CreateApiKeySchema.parse(request.body);
        const key = generateApiKey();

        const apiKey = await context.db.apiKey.create({
          data: {
            orgId: request.orgId!,
            name: body.name,
            keyHash: hashApiKey(key)
          }
        });

        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "api_key.created",
            resource: "api_key",
            resourceId: apiKey.id,
            details: JSON.stringify({ name: body.name })
          }
        });

        reply.status(201).send({
          id: apiKey.id,
          name: apiKey.name,
          key,
          createdAt: apiKey.createdAt.toISOString()
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({
            error: "Invalid request body",
            details: error.errors
          });
          return;
        }

        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to create API key" });
      }
    }
  );

  fastify.delete(
    "/orgs/current/api-keys/:keyId",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      try {
        const { keyId } = request.params as { keyId: string };

        const apiKey = await context.db.apiKey.findUnique({
          where: { id: keyId }
        });

        if (!apiKey || apiKey.orgId !== request.orgId) {
          reply.status(404).send({ error: "API key not found" });
          return;
        }

        await context.db.apiKey.delete({
          where: { id: keyId }
        });

        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "api_key.deleted",
            resource: "api_key",
            resourceId: keyId,
            details: JSON.stringify({ name: apiKey.name })
          }
        });

        reply.send({ success: true });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to delete API key" });
      }
    }
  );
}
