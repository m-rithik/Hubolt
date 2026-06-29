import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ServerContext } from "../app.js";
import { createAuthMiddleware, requireAdmin, isAuthenticated, isAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  listOrgUsers,
  createOrgUser,
  resetUserPassword,
  setUserRole,
  setUserStatus,
  deleteOrgUser,
  UserError
} from "../services/user-management.js";
import {
  listUserRepoAccess,
  grantRepoAccess,
  revokeRepoAccess
} from "../services/repository-access.js";

const PASSWORD_MIN = 12;
const RoleSchema = z.enum(["admin", "developer"]);

const CreateUserSchema = z.object({
  username: z.string().trim().regex(/^[a-zA-Z0-9._-]{3,40}$/, "Username: 3-40 chars, letters/digits/._-"),
  password: z.string().min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`),
  role: RoleSchema.default("developer"),
  name: z.string().trim().max(120).optional()
});

const UpdateUserSchema = z
  .object({
    role: RoleSchema.optional(),
    status: z.enum(["active", "disabled"]).optional(),
    password: z.string().min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`).optional()
  })
  .refine((b) => b.role !== undefined || b.status !== undefined || b.password !== undefined, {
    message: "Provide at least one of: role, status, password"
  });

const GrantSchema = z.object({
  repoId: z.string().trim().min(1),
  accessLevel: z.enum(["read", "actions"]).default("read")
});

function handleError(request: AuthenticatedRequest, reply: FastifyReply, error: unknown, fallback: string): void {
  if (error instanceof z.ZodError) {
    reply.status(400).send({ error: error.errors[0]?.message ?? "Validation error" });
    return;
  }
  if (error instanceof UserError) {
    reply.status(error.statusCode).send({ error: error.message });
    return;
  }
  request.log.error(error);
  reply.status(500).send({ error: fallback });
}

/**
 * Admin user management and per-repo developer access. All routes are admin-only
 * except GET /me/repos, which returns the caller's own accessible repositories.
 */
export function registerUserRoutes(fastify: FastifyInstance, context: ServerContext): void {
  const authMiddleware = createAuthMiddleware(context.db);
  const db = context.db;

  fastify.get("/users", { preHandler: [authMiddleware] }, async (request: AuthenticatedRequest, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const users = await listOrgUsers(db, request.orgId!);
      const repos = await db.repository.findMany({
        where: { orgId: request.orgId!, disabledAt: null },
        select: { id: true, fullName: true, provider: true },
        orderBy: { fullName: "asc" }
      });
      reply.send({ users, repos });
    } catch (error) {
      handleError(request, reply, error, "Failed to list users");
    }
  });

  fastify.post("/users", { preHandler: [authMiddleware] }, async (request: AuthenticatedRequest, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const body = CreateUserSchema.parse(request.body);
      const user = await createOrgUser(db, request.orgId!, body);
      await db.auditEvent.create({
        data: {
          orgId: request.orgId!,
          action: "user.created",
          resource: "user",
          resourceId: user.userId,
          details: JSON.stringify({ username: user.username, role: user.role })
        }
      });
      reply.status(201).send({ user });
    } catch (error) {
      handleError(request, reply, error, "Failed to create user");
    }
  });

  fastify.patch<{ Params: { userId: string } }>(
    "/users/:userId",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest & { params: { userId: string } }, reply) => {
      if (!requireAdmin(request, reply)) return;
      try {
        const body = UpdateUserSchema.parse(request.body);
        const { userId } = request.params;
        if (body.role) await setUserRole(db, request.orgId!, userId, body.role);
        if (body.status) await setUserStatus(db, request.orgId!, userId, body.status);
        if (body.password) await resetUserPassword(db, request.orgId!, userId, body.password);
        await db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "user.updated",
            resource: "user",
            resourceId: userId,
            details: JSON.stringify({
              role: body.role,
              status: body.status,
              passwordReset: Boolean(body.password)
            })
          }
        });
        reply.send({ ok: true });
      } catch (error) {
        handleError(request, reply, error, "Failed to update user");
      }
    }
  );

  fastify.delete<{ Params: { userId: string } }>(
    "/users/:userId",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest & { params: { userId: string } }, reply) => {
      if (!requireAdmin(request, reply)) return;
      try {
        await deleteOrgUser(db, request.orgId!, request.params.userId);
        await db.auditEvent.create({
          data: { orgId: request.orgId!, action: "user.deleted", resource: "user", resourceId: request.params.userId }
        });
        reply.send({ ok: true });
      } catch (error) {
        handleError(request, reply, error, "Failed to delete user");
      }
    }
  );

  // Repo access for one user.
  fastify.get<{ Params: { userId: string } }>(
    "/users/:userId/repos",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest & { params: { userId: string } }, reply) => {
      if (!requireAdmin(request, reply)) return;
      try {
        const access = await listUserRepoAccess(db, request.orgId!, request.params.userId);
        const repos = await db.repository.findMany({
          where: { orgId: request.orgId!, disabledAt: null },
          select: { id: true, fullName: true, provider: true },
          orderBy: { fullName: "asc" }
        });
        reply.send({ access, repos });
      } catch (error) {
        handleError(request, reply, error, "Failed to list repo access");
      }
    }
  );

  fastify.post<{ Params: { userId: string } }>(
    "/users/:userId/repos",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest & { params: { userId: string } }, reply) => {
      if (!requireAdmin(request, reply)) return;
      try {
        const body = GrantSchema.parse(request.body);
        await grantRepoAccess(db, request.orgId!, request.params.userId, body.repoId, body.accessLevel, request.userId);
        await db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "access.granted",
            resource: "repository_access",
            resourceId: body.repoId,
            details: JSON.stringify({ userId: request.params.userId, accessLevel: body.accessLevel })
          }
        });
        const access = await listUserRepoAccess(db, request.orgId!, request.params.userId);
        reply.status(201).send({ access });
      } catch (error) {
        handleError(request, reply, error, "Failed to grant access");
      }
    }
  );

  fastify.delete<{ Params: { userId: string; repoId: string } }>(
    "/users/:userId/repos/:repoId",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest & { params: { userId: string; repoId: string } }, reply) => {
      if (!requireAdmin(request, reply)) return;
      try {
        await revokeRepoAccess(db, request.orgId!, request.params.userId, request.params.repoId);
        await db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "access.revoked",
            resource: "repository_access",
            resourceId: request.params.repoId,
            details: JSON.stringify({ userId: request.params.userId })
          }
        });
        const access = await listUserRepoAccess(db, request.orgId!, request.params.userId);
        reply.send({ access });
      } catch (error) {
        handleError(request, reply, error, "Failed to revoke access");
      }
    }
  );

  // The caller's own accessible repositories (developer dashboard). Admins see all.
  fastify.get("/me/repos", { preHandler: [authMiddleware] }, async (request: AuthenticatedRequest, reply) => {
    if (!isAuthenticated(request)) {
      reply.status(401).send({ error: "Unauthorized" });
      return;
    }
    try {
      if (isAdmin(request)) {
        const repos = await db.repository.findMany({
          where: { orgId: request.orgId!, disabledAt: null },
          select: { id: true, fullName: true, provider: true },
          orderBy: { fullName: "asc" }
        });
        reply.send({ role: "admin", repos: repos.map((r) => ({ ...r, accessLevel: "actions" })) });
        return;
      }
      const access = request.userId ? await listUserRepoAccess(db, request.orgId!, request.userId) : [];
      reply.send({ role: "developer", repos: access });
    } catch (error) {
      handleError(request, reply, error, "Failed to list your repositories");
    }
  });
}
