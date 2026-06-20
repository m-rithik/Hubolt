import { FastifyInstance } from "fastify";
import { Prisma } from "../../generated/prisma/index.js";
import { ServerContext } from "../app.js";
import { generateApiKey, hashApiKey } from "../api-keys.js";
import { AuthenticatedRequest, createAuthMiddleware, isAuthenticated, requireAdmin } from "../middleware/auth.js";
import { z } from "zod";

const MEMBER_ROLES = ["admin", "reviewer", "viewer"] as const;

const CreateApiKeySchema = z.object({
  name: z.string().min(1),
  // New keys default to the least-privileged role; an admin must opt a key up.
  role: z.enum(["admin", "viewer"]).default("viewer"),
  // Optional lifetime; the auth middleware rejects keys past their expiry.
  expiresInDays: z.number().int().positive().max(3650).optional(),
  // Optional owner: an org member this key belongs to.
  memberId: z.string().optional()
});

const UpdateApiKeySchema = z
  .object({
    role: z.enum(["admin", "viewer"]).optional(),
    // A string assigns an owner; null unassigns it.
    memberId: z.string().nullable().optional()
  })
  .refine((body) => body.role !== undefined || body.memberId !== undefined, {
    message: "Provide role and/or memberId"
  });

const RenameOrgSchema = z.object({
  name: z.string().min(1).max(200)
});

const AddMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200).optional(),
  role: z.enum(MEMBER_ROLES).default("viewer")
});

const UpdateMemberRoleSchema = z.object({
  role: z.enum(MEMBER_ROLES)
});

export function registerOrgRoutes(fastify: FastifyInstance, context: ServerContext): void {
  const authMiddleware = createAuthMiddleware(context.db);

  // Identity of the presented key, so the dashboard can show read-only controls
  // to viewers.
  fastify.get(
    "/auth/me",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      reply.send({ orgId: request.orgId, role: request.role ?? "admin" });
    }
  );

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
              select: {
                id: true,
                name: true,
                role: true,
                createdAt: true,
                expiresAt: true,
                lastUsedAt: true,
                memberId: true,
                member: { select: { user: { select: { email: true, name: true } } } }
              }
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
            role: k.role,
            memberId: k.memberId ?? null,
            member: k.member ? { email: k.member.user.email, name: k.member.user.name } : null,
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
      if (!requireAdmin(request, reply)) {
        return;
      }

      try {
        const body = CreateApiKeySchema.parse(request.body);

        if (body.memberId && !(await isMemberOfOrg(context.db, request.orgId!, body.memberId))) {
          reply.status(400).send({ error: "Owner is not a member of this organization" });
          return;
        }

        const key = generateApiKey();
        const expiresAt = body.expiresInDays
          ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
          : null;

        const apiKey = await context.db.apiKey.create({
          data: {
            orgId: request.orgId!,
            name: body.name,
            role: body.role,
            keyHash: hashApiKey(key),
            expiresAt,
            memberId: body.memberId ?? null
          }
        });

        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "api_key.created",
            resource: "api_key",
            resourceId: apiKey.id,
            details: JSON.stringify({ name: body.name, role: body.role, expiresAt: expiresAt?.toISOString() ?? null })
          }
        });

        reply.status(201).send({
          id: apiKey.id,
          name: apiKey.name,
          role: apiKey.role,
          key,
          expiresAt: apiKey.expiresAt?.toISOString() ?? null,
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

  fastify.patch<{ Params: { keyId: string }; Body: z.infer<typeof UpdateApiKeySchema> }>(
    "/orgs/current/api-keys/:keyId",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      if (!requireAdmin(request, reply)) {
        return;
      }

      let body: z.infer<typeof UpdateApiKeySchema>;
      try {
        body = UpdateApiKeySchema.parse(request.body);
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: "Invalid request body", details: error.errors });
          return;
        }
        throw error;
      }

      try {
        const { keyId } = request.params as { keyId: string };

        // The last-admin guard and the mutation run in one transaction with the
        // admin rows locked, so two concurrent demotions cannot both observe
        // more than one admin and leave the org with zero.
        const updated = await context.db.$transaction(async (tx) => {
          const apiKey = await tx.apiKey.findUnique({ where: { id: keyId } });

          if (!apiKey || apiKey.orgId !== request.orgId) {
            throw new ApiKeyMutationError(404, "API key not found");
          }

          if (body.role !== undefined && apiKey.role === "admin" && body.role !== "admin") {
            if ((await countAdminsLocked(tx, request.orgId!)) <= 1) {
              throw new ApiKeyMutationError(400, "Cannot demote the last admin key");
            }
          }

          // A non-null owner must be a member of this org.
          if (body.memberId && !(await isMemberOfOrg(tx, request.orgId!, body.memberId))) {
            throw new ApiKeyMutationError(400, "Owner is not a member of this organization");
          }

          const data: { role?: string; memberId?: string | null } = {};
          if (body.role !== undefined) data.role = body.role;
          if (body.memberId !== undefined) data.memberId = body.memberId;

          const row = await tx.apiKey.update({ where: { id: keyId }, data });

          await tx.auditEvent.create({
            data: {
              orgId: request.orgId!,
              action: body.role !== undefined ? "api_key.role_changed" : "api_key.assigned",
              resource: "api_key",
              resourceId: keyId,
              details: JSON.stringify({ name: apiKey.name, role: data.role, memberId: data.memberId })
            }
          });

          return row;
        });

        reply.send({ id: updated.id, name: updated.name, role: updated.role, memberId: updated.memberId });
      } catch (error) {
        if (error instanceof ApiKeyMutationError) {
          reply.status(error.statusCode).send({ error: error.message });
          return;
        }
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to update API key" });
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
      if (!requireAdmin(request, reply)) {
        return;
      }

      try {
        const { keyId } = request.params as { keyId: string };

        // Same race guard as demotion: lock the admin rows so a concurrent
        // delete/demote cannot also pass the last-admin check.
        await context.db.$transaction(async (tx) => {
          const apiKey = await tx.apiKey.findUnique({ where: { id: keyId } });

          if (!apiKey || apiKey.orgId !== request.orgId) {
            throw new ApiKeyMutationError(404, "API key not found");
          }

          if (apiKey.role === "admin" && (await countAdminsLocked(tx, request.orgId!)) <= 1) {
            throw new ApiKeyMutationError(400, "Cannot remove the last admin key");
          }

          await tx.apiKey.delete({ where: { id: keyId } });

          await tx.auditEvent.create({
            data: {
              orgId: request.orgId!,
              action: "api_key.deleted",
              resource: "api_key",
              resourceId: keyId,
              details: JSON.stringify({ name: apiKey.name })
            }
          });
        });

        reply.send({ success: true });
      } catch (error) {
        if (error instanceof ApiKeyMutationError) {
          reply.status(error.statusCode).send({ error: error.message });
          return;
        }
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to delete API key" });
      }
    }
  );

  // Rename the organization (the slug stays the stable identity).
  fastify.patch<{ Body: z.infer<typeof RenameOrgSchema> }>(
    "/orgs/current",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      if (!requireAdmin(request, reply)) {
        return;
      }

      let body: z.infer<typeof RenameOrgSchema>;
      try {
        body = RenameOrgSchema.parse(request.body);
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: "Invalid request body", details: error.errors });
          return;
        }
        throw error;
      }

      try {
        const org = await context.db.organization.update({
          where: { id: request.orgId! },
          data: { name: body.name }
        });
        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "organization.renamed",
            resource: "organization",
            resourceId: org.id,
            details: JSON.stringify({ name: body.name })
          }
        });
        reply.send({ id: org.id, name: org.name, slug: org.slug });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to rename organization" });
      }
    }
  );

  // Add (or re-invite) a member by email.
  fastify.post<{ Body: z.infer<typeof AddMemberSchema> }>(
    "/orgs/current/members",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      if (!requireAdmin(request, reply)) {
        return;
      }

      let body: z.infer<typeof AddMemberSchema>;
      try {
        body = AddMemberSchema.parse(request.body);
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: "Invalid request body", details: error.errors });
          return;
        }
        throw error;
      }

      try {
        const email = body.email.toLowerCase();
        const user = await context.db.user.upsert({
          where: { email },
          create: { email, name: body.name ?? email.split("@")[0] },
          update: body.name ? { name: body.name } : {}
        });
        const member = await context.db.organizationMember.upsert({
          where: { orgId_userId: { orgId: request.orgId!, userId: user.id } },
          create: { orgId: request.orgId!, userId: user.id, role: body.role },
          update: { role: body.role }
        });
        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "member.added",
            resource: "member",
            resourceId: member.id,
            details: JSON.stringify({ email, role: body.role })
          }
        });
        reply.status(201).send({ id: member.id, email: user.email, name: user.name, role: member.role });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to add member" });
      }
    }
  );

  // Change a member's role.
  fastify.patch<{ Params: { memberId: string }; Body: z.infer<typeof UpdateMemberRoleSchema> }>(
    "/orgs/current/members/:memberId",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      if (!requireAdmin(request, reply)) {
        return;
      }

      let body: z.infer<typeof UpdateMemberRoleSchema>;
      try {
        body = UpdateMemberRoleSchema.parse(request.body);
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: "Invalid request body", details: error.errors });
          return;
        }
        throw error;
      }

      try {
        const { memberId } = request.params as { memberId: string };
        const member = await context.db.organizationMember.findUnique({ where: { id: memberId } });
        if (!member || member.orgId !== request.orgId) {
          reply.status(404).send({ error: "Member not found" });
          return;
        }
        const updated = await context.db.organizationMember.update({
          where: { id: memberId },
          data: { role: body.role }
        });
        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "member.role_changed",
            resource: "member",
            resourceId: memberId,
            details: JSON.stringify({ from: member.role, to: body.role })
          }
        });
        reply.send({ id: updated.id, role: updated.role });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to update member" });
      }
    }
  );

  // Remove a member.
  fastify.delete(
    "/orgs/current/members/:memberId",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      if (!requireAdmin(request, reply)) {
        return;
      }

      try {
        const { memberId } = request.params as { memberId: string };
        const member = await context.db.organizationMember.findUnique({ where: { id: memberId } });
        if (!member || member.orgId !== request.orgId) {
          reply.status(404).send({ error: "Member not found" });
          return;
        }
        await context.db.organizationMember.delete({ where: { id: memberId } });
        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "member.removed",
            resource: "member",
            resourceId: memberId,
            details: JSON.stringify({ userId: member.userId })
          }
        });
        reply.send({ success: true });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to remove member" });
      }
    }
  );
}

/** Maps a guarded API-key mutation failure to an HTTP status instead of a 500. */
class ApiKeyMutationError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * Count the org's admin keys while holding a FOR UPDATE lock on those rows. Run
 * inside a transaction: the lock serializes concurrent demotions/deletions so
 * two of them cannot both observe more than one admin and drop the org to zero.
 */
async function countAdminsLocked(tx: Prisma.TransactionClient, orgId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "api_keys" WHERE "orgId" = ${orgId} AND "role" = 'admin' FOR UPDATE
  `;
  return rows.length;
}

/** True when memberId names a member of this org. */
async function isMemberOfOrg(db: Prisma.TransactionClient, orgId: string, memberId: string): Promise<boolean> {
  const member = await db.organizationMember.findUnique({ where: { id: memberId }, select: { orgId: true } });
  return member?.orgId === orgId;
}
