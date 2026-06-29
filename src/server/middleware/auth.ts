import { FastifyRequest, FastifyReply } from "fastify";
import { PrismaClient } from "../../generated/prisma/index.js";
import { hashApiKey } from "../api-keys.js";
import { isSessionToken, hashSessionToken } from "../auth/sessions.js";

export interface AuthenticatedRequest extends FastifyRequest {
  authenticated?: boolean;
  orgId?: string;
  /** "admin" or "developer" (API keys use "admin"/"viewer"; viewer maps to developer). */
  role?: string;
  /** Set when authenticated via a username/password session. */
  userId?: string;
}

/** Normalize a stored role to the two-role model. Legacy "viewer" is developer. */
function normalizeRole(role: string | null | undefined): string {
  return role === "admin" ? "admin" : "developer";
}

/** Request path without query string. */
function currentPath(request: FastifyRequest): string {
  return (request.url || "").split("?")[0];
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

    // Username/password session tokens resolve to a user and their org role.
    if (isSessionToken(key)) {
      try {
        const session = await db.session.findUnique({
          where: { tokenHash: hashSessionToken(key) },
          include: { user: { include: { orgs: true } } }
        });
        if (!session || session.expiresAt < new Date()) {
          reply.status(401).send({ error: "Invalid or expired session" });
          return;
        }
        if (session.user.status !== "active") {
          reply.status(401).send({ error: "Account is disabled" });
          return;
        }
        const membership = session.user.orgs.find((entry) => entry.orgId === session.orgId);
        if (!membership) {
          reply.status(401).send({ error: "Session organization is no longer available" });
          return;
        }
        // A user with a temporary (admin-set) password may only change it or log
        // out until they do so; every other route is blocked.
        if (session.user.mustChangePassword && currentPath(request) !== "/auth/password") {
          reply
            .status(403)
            .send({ error: "Password change required", code: "password_change_required" });
          return;
        }
        request.authenticated = true;
        request.orgId = membership.orgId;
        request.userId = session.userId;
        request.role = normalizeRole(membership.role);

        if (shouldTouchLastUsed(session.lastUsedAt)) {
          try {
            await db.session.update({
              where: { id: session.id },
              data: { lastUsedAt: new Date() }
            });
          } catch (error) {
            request.server.log.error(error);
          }
        }
      } catch (error) {
        request.server.log.error(error);
        reply.status(500).send({ error: "Authentication failed" });
      }
      return;
    }

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
      // Keys created before roles existed have no value; treat them as admin so
      // existing access is preserved.
      request.role = (apiKey as { role?: string }).role ?? "admin";
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

export function isAdmin(request: AuthenticatedRequest): boolean {
  return request.role === "admin";
}

/**
 * A session-authenticated developer (has a user, not an admin). Org-level API
 * keys are not developers. Used to gate org-wide read surfaces (audit, memory)
 * that have no per-repo scoping.
 */
export function isSessionDeveloper(request: AuthenticatedRequest): boolean {
  return Boolean(request.userId) && request.role !== "admin";
}

/**
 * Guard for state-changing routes: returns true when the caller is an admin,
 * otherwise sends 403 and returns false. Call after isAuthenticated.
 */
export function requireAdmin(request: AuthenticatedRequest, reply: FastifyReply): boolean {
  if (!isAdmin(request)) {
    reply.status(403).send({ error: "Forbidden: this action requires admin access" });
    return false;
  }
  return true;
}
