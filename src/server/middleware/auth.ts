import { FastifyRequest, FastifyReply } from "fastify";
import { PrismaClient } from "../../generated/prisma/index.js";
import { hashApiKey } from "../api-keys.js";

export interface AuthenticatedRequest extends FastifyRequest {
  authenticated?: boolean;
  orgId?: string;
}

/**
 * lastUsedAt is observability data, not an audit trail; writing it on every
 * request doubles database round-trips. Refresh it at most this often.
 */
export const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export function shouldTouchLastUsed(lastUsedAt: Date | null, now: Date = new Date()): boolean {
  return !lastUsedAt || now.getTime() - lastUsedAt.getTime() >= LAST_USED_WRITE_INTERVAL_MS;
}

export function createAuthMiddleware(db: PrismaClient) {
  return async (request: AuthenticatedRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      reply.status(401).send({ error: "Missing or invalid authorization header" });
      return;
    }

    const key = authHeader.slice(7);
    let staleLastUsed = false;

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

      request.authenticated = true;
      request.orgId = apiKey.orgId;
      staleLastUsed = shouldTouchLastUsed(apiKey.lastUsedAt);
    } catch (error) {
      request.server.log.error(error);
      reply.status(500).send({ error: "Authentication failed" });
      return;
    }

    // lastUsedAt is bookkeeping; a failure here must not reject a request
    // that has already authenticated successfully.
    if (staleLastUsed) {
      try {
        await db.apiKey.update({
          where: { keyHash: hashApiKey(key) },
          data: { lastUsedAt: new Date() }
        });
      } catch (error) {
        request.server.log.error(error);
      }
    }
  };
}

export function isAuthenticated(request: AuthenticatedRequest): boolean {
  return Boolean(request.authenticated && request.orgId);
}
