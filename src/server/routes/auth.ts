import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ServerContext } from "../app.js";
import { createAuthMiddleware, isAuthenticated, type AuthenticatedRequest } from "../middleware/auth.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { generateSessionToken, hashSessionToken, isSessionToken } from "../auth/sessions.js";
import { isLockedOut, recordFailure, recordSuccess } from "../auth/login-throttle.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_MIN = 12;

// Verified against on every login (even for unknown users) so the scrypt cost is
// paid regardless, preventing username enumeration via response timing.
const DUMMY_PASSWORD_HASH = hashPassword("hubolt-login-timing-equalizer-placeholder");

const LoginSchema = z.object({
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  orgId: z.string().trim().min(1).optional()
});

const PasswordChangeSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(PASSWORD_MIN, `New password must be at least ${PASSWORD_MIN} characters`)
});

function normalizeRole(role: string | null | undefined): string {
  return role === "admin" ? "admin" : "developer";
}

/**
 * Username/password authentication. Login issues an opaque session token (only
 * its hash is stored); the auth middleware accepts it like an API key. Failed
 * logins return a generic message to avoid revealing whether a username exists.
 */
export function registerAuthRoutes(fastify: FastifyInstance, context: ServerContext): void {
  const authMiddleware = createAuthMiddleware(context.db);

  fastify.post("/auth/login", async (request: AuthenticatedRequest, reply: FastifyReply) => {
    let body: z.infer<typeof LoginSchema>;
    try {
      body = LoginSchema.parse(request.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        reply.status(400).send({ error: error.errors[0]?.message ?? "Invalid request" });
        return;
      }
      throw error;
    }

    // Brute-force throttle, keyed by username + client ip.
    const throttleKey = `${body.username.toLowerCase()}:${request.ip}`;
    if (isLockedOut(throttleKey)) {
      reply.status(429).send({ error: "Too many login attempts. Try again later." });
      return;
    }

    try {
      const user = await context.db.user.findUnique({
        where: { username: body.username },
        include: { orgs: { include: { org: { select: { id: true, name: true, slug: true } } } } }
      });

      // Always run a scrypt verify (against a dummy hash when the user or hash is
      // absent) so timing does not reveal whether the username exists.
      const hash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
      const ok = verifyPassword(body.password, hash);
      if (!user || !user.passwordHash || !ok) {
        recordFailure(throttleKey);
        reply.status(401).send({ error: "Invalid username or password" });
        return;
      }
      // Credentials are valid past this point; revealing these states does not
      // enable enumeration.
      if (user.status !== "active") {
        reply.status(403).send({ error: "Account is disabled" });
        return;
      }
      const membership = selectMembership(user.orgs, body.orgId);
      if (!membership) {
        if (user.orgs.length > 1 && !body.orgId) {
          reply.status(409).send({
            error: "Organization selection required",
            organizations: user.orgs.map((entry) => ({
              id: entry.orgId,
              name: entry.org.name,
              slug: entry.org.slug,
              role: normalizeRole(entry.role)
            }))
          });
          return;
        }
        reply.status(403).send({ error: body.orgId ? "User is not a member of this organization" : "User has no organization" });
        return;
      }
      recordSuccess(throttleKey);

      const token = generateSessionToken();
      const ua = request.headers["user-agent"];
      await context.db.session.create({
        data: {
          userId: user.id,
          orgId: membership.orgId,
          tokenHash: hashSessionToken(token),
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
          ip: request.ip,
          userAgent: typeof ua === "string" ? ua.slice(0, 300) : null
        }
      });

      await context.db.auditEvent.create({
        data: {
          orgId: membership.orgId,
          action: "auth.login",
          resource: "user",
          resourceId: user.id,
          details: JSON.stringify({ username: user.username })
        }
      });

      reply.send({
        token,
        role: normalizeRole(membership.role),
        mustChangePassword: user.mustChangePassword,
        org: { id: membership.orgId, name: membership.org.name, slug: membership.org.slug },
        user: { id: user.id, username: user.username, name: user.name }
      });
    } catch (error) {
      request.log.error(error);
      reply.status(500).send({ error: "Login failed" });
    }
  });

  // Logout deletes the presented session. No standard guard: it only needs the
  // token to identify which session to remove.
  fastify.post("/auth/logout", async (request: AuthenticatedRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    if (token && isSessionToken(token)) {
      try {
        await context.db.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
      } catch (error) {
        request.log.error(error);
      }
    }
    reply.send({ ok: true });
  });

  fastify.post(
    "/auth/password",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      if (!isAuthenticated(request) || !request.userId) {
        reply.status(401).send({ error: "Password change requires a logged-in user session" });
        return;
      }
      let body: z.infer<typeof PasswordChangeSchema>;
      try {
        body = PasswordChangeSchema.parse(request.body);
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: error.errors[0]?.message ?? "Invalid request" });
          return;
        }
        throw error;
      }

      try {
        const user = await context.db.user.findUnique({ where: { id: request.userId } });
        if (!user?.passwordHash || !verifyPassword(body.currentPassword, user.passwordHash)) {
          reply.status(401).send({ error: "Current password is incorrect" });
          return;
        }
        await context.db.user.update({
          where: { id: user.id },
          data: { passwordHash: hashPassword(body.newPassword), mustChangePassword: false }
        });
        // Invalidate other sessions on password change.
        await context.db.session.deleteMany({ where: { userId: user.id } });
        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "auth.password_changed",
            resource: "user",
            resourceId: user.id
          }
        });
        reply.send({ ok: true });
      } catch (error) {
        request.log.error(error);
        reply.status(500).send({ error: "Failed to change password" });
      }
    }
  );
}

function selectMembership<
  T extends { orgId: string; role: string | null; org: { id: string; name: string; slug: string } }
>(memberships: T[], requestedOrgId?: string): T | null {
  if (requestedOrgId) {
    return memberships.find((membership) => membership.orgId === requestedOrgId) ?? null;
  }
  return memberships.length === 1 ? memberships[0] : null;
}
