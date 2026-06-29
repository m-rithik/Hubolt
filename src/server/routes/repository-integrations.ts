import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ServerContext } from "../app.js";
import { createAuthMiddleware, requireAdmin, isAuthenticated, isAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  upsertIntegration,
  listIntegrations,
  deleteIntegration,
  IntegrationConflictError
} from "../services/repository-integrations.js";
import { accessibleRepoIds } from "../services/repository-access.js";

const SaveSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  provider: z.enum(["github", "bitbucket"]).default("bitbucket"),
  token: z.string().trim().min(10, "API token looks too short"),
  // Required: the webhook route rejects deliveries for integrations without a
  // secret, so a secretless integration would be non-functional.
  webhookSecret: z.string().trim().min(8, "Webhook secret is required (min 8 characters)"),
  slackWebhookUrl: z.string().trim().url("Slack webhook must be a valid URL").optional()
});

// Create-by-repo: the admin types the Bitbucket repo (workspace/repo) and the
// repository record is created on the fly, so there is no separate "register a
// repo" step. Provider is implied (Bitbucket).
const CreateSchema = z.object({
  repoFullName: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/, "Use workspace/repo format, e.g. acme/payments"),
  name: z.string().trim().min(1, "Name is required"),
  token: z.string().trim().min(10, "API token looks too short"),
  webhookSecret: z.string().trim().min(8, "Webhook secret is required (min 8 characters)"),
  slackWebhookUrl: z.string().trim().url("Slack webhook must be a valid URL").optional()
});

/**
 * Named per-repository integrations: one repo ↔ one token ↔ one webhook secret,
 * under an admin label. GET returns masked integrations plus the org's repos
 * (for attaching). Writes are admin-only; secrets are never returned.
 */
export function registerRepositoryIntegrationRoutes(fastify: FastifyInstance, context: ServerContext): void {
  const authMiddleware = createAuthMiddleware(context.db);

  fastify.get(
    "/integrations",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      try {
        let integrations = await listIntegrations(context.db, request.orgId!);
        let repos = await context.db.repository.findMany({
          where: { orgId: request.orgId!, disabledAt: null },
          select: { id: true, fullName: true, provider: true },
          orderBy: { fullName: "asc" }
        });
        // Developers only see repositories they have been granted access to.
        if (!isAdmin(request)) {
          const allowed = request.userId
            ? await accessibleRepoIds(context.db, request.orgId!, request.userId)
            : new Set<string>();
          integrations = integrations.filter((i) => allowed.has(i.repoId));
          repos = repos.filter((r) => allowed.has(r.id));
        }
        reply.send({ integrations, repos });
      } catch (error) {
        request.log.error(error);
        reply.status(500).send({ error: "Failed to list integrations" });
      }
    }
  );

  fastify.post(
    "/integrations",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest, reply: FastifyReply) => {
      if (!requireAdmin(request, reply)) {
        return;
      }
      try {
        const body = CreateSchema.parse(request.body);
        const orgId = request.orgId!;
        // Create the repo record if this is the first time we see it.
        const repo = await context.db.repository.upsert({
          where: { orgId_fullName: { orgId, fullName: body.repoFullName } },
          create: {
            orgId,
            name: body.repoFullName.split("/")[1] ?? body.repoFullName,
            fullName: body.repoFullName,
            url: `https://bitbucket.org/${body.repoFullName}`,
            provider: "bitbucket"
          },
          update: { provider: "bitbucket" }
        });
        await upsertIntegration(context.db, {
          orgId,
          repoId: repo.id,
          provider: "bitbucket",
          name: body.name,
          token: body.token,
          webhookSecret: body.webhookSecret,
          slackWebhookUrl: body.slackWebhookUrl
        });
        await context.db.auditEvent.create({
          data: {
            orgId,
            action: "integration.saved",
            resource: "repository_integration",
            resourceId: repo.id,
            details: JSON.stringify({ name: body.name, repo: body.repoFullName })
          }
        });
        reply.status(201).send({ integrations: await listIntegrations(context.db, orgId) });
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: error.errors[0]?.message ?? "Validation error" });
          return;
        }
        if (error instanceof IntegrationConflictError) {
          reply.status(409).send({ error: error.message });
          return;
        }
        request.log.error(error);
        reply.status(500).send({ error: "Failed to create integration" });
      }
    }
  );

  fastify.put<{ Params: { repoId: string } }>(
    "/integrations/:repoId",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest & { params: { repoId: string } }, reply: FastifyReply) => {
      if (!requireAdmin(request, reply)) {
        return;
      }
      const repoId = request.params.repoId;
      try {
        const body = SaveSchema.parse(request.body);
        const repo = await context.db.repository.findFirst({
          where: { id: repoId, orgId: request.orgId! },
          select: { id: true }
        });
        if (!repo) {
          reply.status(404).send({ error: "Repository not found in this organization" });
          return;
        }
        await upsertIntegration(context.db, {
          orgId: request.orgId!,
          repoId,
          provider: body.provider,
          name: body.name,
          token: body.token,
          webhookSecret: body.webhookSecret,
          slackWebhookUrl: body.slackWebhookUrl
        });
        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "integration.saved",
            resource: "repository_integration",
            resourceId: repoId,
            details: JSON.stringify({ name: body.name, provider: body.provider })
          }
        });
        const integrations = await listIntegrations(context.db, request.orgId!);
        reply.status(201).send({ integrations });
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: error.errors[0]?.message ?? "Validation error" });
          return;
        }
        if (error instanceof IntegrationConflictError) {
          reply.status(409).send({ error: error.message });
          return;
        }
        request.log.error(error);
        reply.status(500).send({ error: "Failed to save integration" });
      }
    }
  );

  fastify.delete<{ Params: { repoId: string } }>(
    "/integrations/:repoId",
    { preHandler: [authMiddleware] },
    async (request: AuthenticatedRequest & { params: { repoId: string } }, reply: FastifyReply) => {
      if (!requireAdmin(request, reply)) {
        return;
      }
      try {
        await deleteIntegration(context.db, request.orgId!, request.params.repoId);
        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "integration.deleted",
            resource: "repository_integration",
            resourceId: request.params.repoId
          }
        });
        const integrations = await listIntegrations(context.db, request.orgId!);
        reply.send({ integrations });
      } catch (error) {
        request.log.error(error);
        reply.status(500).send({ error: "Failed to delete integration" });
      }
    }
  );
}
