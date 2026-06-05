import { FastifyRequest, FastifyReply } from "fastify";
import { PrismaClient } from "../../generated/prisma/client.js";
import { hashApiKey } from "../api-keys.js";

export interface AuthenticatedRequest extends FastifyRequest {
  apiKey?: string;
  orgId?: string;
}

export function createAuthMiddleware(db: PrismaClient) {
  return async (request: AuthenticatedRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      reply.status(401).send({ error: "Missing or invalid authorization header" });
      return;
    }

    const key = authHeader.slice(7);

    try {
      const apiKey = await db.apiKey.findUnique({
        where: { keyHash: hashApiKey(key) },
        include: { org: true }
      });

      if (!apiKey || !apiKey.org) {
        reply.status(401).send({ error: "Invalid API key" });
        return;
      }

      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        reply.status(401).send({ error: "API key expired" });
        return;
      }

      request.apiKey = key;
      request.orgId = apiKey.orgId;

      await db.apiKey.update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() }
      });
    } catch (error) {
      request.server.log.error(error);
      reply.status(500).send({ error: "Authentication failed" });
      return;
    }
  };
}

export function isAuthenticated(request: AuthenticatedRequest): boolean {
  return Boolean(request.apiKey && request.orgId);
}
