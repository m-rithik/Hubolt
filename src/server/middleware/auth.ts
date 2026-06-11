import { FastifyRequest, FastifyReply } from "fastify";
import { PrismaClient } from "../../generated/prisma/index.js";
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
    } catch (error) {
      request.server.log.error(error);
      reply.status(500).send({ error: "Authentication failed" });
      return;
    }

    // lastUsedAt is bookkeeping; a failure here must not reject a request
    // that has already authenticated successfully.
    try {
      await db.apiKey.update({
        where: { keyHash: hashApiKey(key) },
        data: { lastUsedAt: new Date() }
      });
    } catch (error) {
      request.server.log.error(error);
    }
  };
}

export function isAuthenticated(request: AuthenticatedRequest): boolean {
  return Boolean(request.apiKey && request.orgId);
}
