import { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import { z } from "zod";
import { ServerContext } from "../app.js";
import { AuthenticatedRequest, createAuthMiddleware, isAuthenticated, isAdmin, requireAdmin } from "../middleware/auth.js";
import { readableRepoIds } from "../services/repository-access.js";
import { gitHubAppInstallUrl, isGitHubAppConfigured } from "../services/github-app.js";
import { CredentialManager } from "../services/credential-manager.js";
import { REVIEW_QUEUE_NAME } from "../../queue/review-jobs.js";
import { getProviderInfo } from "../../providers/llm/catalog.js";

const ReviewModelSchema = z.object({
  provider: z.string().min(1).max(50),
  model: z.string().min(1).max(200)
});

const RegisterRepoSchema = z.object({
  url: z.string().min(1).max(500)
});

interface RepoDTO {
  fullName: string;
  url: string;
  /** True once a GitHub App installation has been seen for this repo. */
  installed: boolean;
  createdAt: string;
}

interface RepoIdentity {
  owner: string;
  repo: string;
  fullName: string;
  url: string;
}

/**
 * Admin-facing repository registry. An org admin pastes a GitHub repo link; the
 * repo is recorded so the webhook handler accepts its pull requests. Access to
 * comment on it comes from the GitHub App installation (see github-app.ts), not
 * from anything stored here.
 */
export function registerGitHubRepoRoutes(fastify: FastifyInstance, context: ServerContext): void {
  const authMiddleware = createAuthMiddleware(context.db);

  fastify.get(
    "/github-repos",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      try {
        const ids = await readableRepoIds(context.db, request.orgId!, request.userId, isAdmin(request));
        const repos = await context.db.repository.findMany({
          where: { orgId: request.orgId, disabledAt: null, ...(ids ? { id: { in: ids } } : {}) },
          orderBy: { createdAt: "desc" }
        });

        const dtos: RepoDTO[] = repos.map((repo) => ({
          fullName: repo.fullName,
          url: repo.url,
          installed: repo.installationId != null,
          createdAt: repo.createdAt.toISOString()
        }));

        reply.send({
          repos: dtos,
          appConfigured: isGitHubAppConfigured(),
          installUrl: gitHubAppInstallUrl()
        });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to list repositories" });
      }
    }
  );

  fastify.post<{ Body: z.infer<typeof RegisterRepoSchema> }>(
    "/github-repos",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      if (!requireAdmin(request, reply)) {
        return;
      }

      let body: z.infer<typeof RegisterRepoSchema>;
      try {
        body = RegisterRepoSchema.parse(request.body);
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: "Invalid request body", details: error.errors });
          return;
        }
        throw error;
      }

      const identity = parseRepoInput(body.url);
      if (!identity) {
        reply.status(400).send({ error: "Not a valid GitHub repository URL (expected github.com/owner/repo)" });
        return;
      }

      try {
        const org = await context.db.organization.findUnique({
          where: { id: request.orgId! },
          select: { slug: true }
        });
        if (!org) {
          reply.status(404).send({ error: "Organization not found" });
          return;
        }
        if (normalizeGithubOwner(org.slug) !== normalizeGithubOwner(identity.owner)) {
          reply.status(403).send({ error: "Repository owner must match this organization's slug" });
          return;
        }

        const conflictingRepo = await context.db.repository.findFirst({
          where: {
            fullName: identity.fullName,
            orgId: { not: request.orgId! },
            disabledAt: null
          },
          select: { id: true }
        });
        if (conflictingRepo) {
          reply.status(409).send({ error: "Repository is already registered by another organization" });
          return;
        }

        const repo = await context.db.repository.upsert({
          where: { orgId_fullName: { orgId: request.orgId!, fullName: identity.fullName } },
          create: {
            orgId: request.orgId!,
            name: identity.repo,
            fullName: identity.fullName,
            url: identity.url
          },
          // Re-registering a previously removed repo re-enables it; its prior
          // reviews (preserved by soft-disable) come back with it.
          update: { name: identity.repo, url: identity.url, disabledAt: null }
        });

        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "repository.registered",
            resource: "repository",
            resourceId: repo.id,
            details: JSON.stringify({ fullName: identity.fullName, url: identity.url })
          }
        });

        reply.status(201).send({
          fullName: repo.fullName,
          url: repo.url,
          installed: repo.installationId != null,
          createdAt: repo.createdAt.toISOString()
        } satisfies RepoDTO);
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to register repository" });
      }
    }
  );

  // fullName carries a slash, so it is taken as two path segments rather than a
  // single percent-encoded parameter.
  fastify.delete(
    "/github-repos/:owner/:repo",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      if (!requireAdmin(request, reply)) {
        return;
      }

      const { owner, repo } = request.params as { owner: string; repo: string };
      const fullName = `${owner}/${repo}`;

      try {
        const existing = await context.db.repository.findUnique({
          where: { orgId_fullName: { orgId: request.orgId!, fullName } }
        });

        if (!existing || existing.disabledAt) {
          reply.status(404).send({ error: "Repository not found" });
          return;
        }

        // Soft-disable: stops future reviews but preserves this repo's stored
        // reviews/findings. A hard delete would cascade them away.
        await context.db.repository.update({
          where: { id: existing.id },
          data: { disabledAt: new Date() }
        });

        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "repository.unregistered",
            resource: "repository",
            resourceId: existing.id,
            details: JSON.stringify({ fullName })
          }
        });

        reply.send({ success: true });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to unregister repository" });
      }
    }
  );

  // The LLM reviews use, sourced from the org's gateway-stored credentials.
  fastify.get(
    "/github-repos/review-model",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      try {
        const org = await context.db.organization.findUnique({
          where: { id: request.orgId! },
          select: { reviewLlmProvider: true, reviewLlmModel: true }
        });
        reply.send({
          provider: org?.reviewLlmProvider ?? null,
          model: org?.reviewLlmModel ?? null,
          providers: await listGatewayProviders(context.db, request.orgId!)
        });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to load review model" });
      }
    }
  );

  fastify.put<{ Body: z.infer<typeof ReviewModelSchema> }>(
    "/github-repos/review-model",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      if (!requireAdmin(request, reply)) {
        return;
      }

      let body: z.infer<typeof ReviewModelSchema>;
      try {
        body = ReviewModelSchema.parse(request.body);
      } catch (error) {
        if (error instanceof z.ZodError) {
          reply.status(400).send({ error: "Invalid request body", details: error.errors });
          return;
        }
        throw error;
      }

      // The chosen provider must have a credential stored in the Gateway: that
      // encrypted key is what the worker uses, so picking a provider without one
      // would silently fall back to the server env.
      const providers = await listGatewayProviders(context.db, request.orgId!);
      if (!providers.some((entry) => entry.id === body.provider)) {
        reply.status(400).send({
          error: `No gateway credential for "${body.provider}". Add its API key in the Gateway tab first.`
        });
        return;
      }

      try {
        await context.db.organization.update({
          where: { id: request.orgId! },
          data: { reviewLlmProvider: body.provider, reviewLlmModel: body.model }
        });
        await context.db.auditEvent.create({
          data: {
            orgId: request.orgId!,
            action: "review.model_configured",
            resource: "organization",
            details: JSON.stringify({ provider: body.provider, model: body.model })
          }
        });
        reply.send({ provider: body.provider, model: body.model });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: "Failed to save review model" });
      }
    }
  );

  // Live review-queue pressure for the processing panel.
  const reviewQueue = context.redis ? new Queue(REVIEW_QUEUE_NAME, { connection: context.redis }) : null;
  if (reviewQueue) {
    fastify.addHook("onClose", async () => {
      await reviewQueue.close();
    });
  }

  fastify.get(
    "/github-repos/status",
    { preHandler: authMiddleware },
    async (request: AuthenticatedRequest, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401).send({ error: "Unauthorized" });
        return;
      }

      if (!reviewQueue) {
        reply.send({ queue: null });
        return;
      }

      try {
        const counts = await reviewQueue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
        reply.send({ queue: counts });
      } catch (error) {
        fastify.log.error(error);
        reply.send({ queue: null });
      }
    }
  );
}

/** Providers the org has a gateway credential for, with label and default model. */
async function listGatewayProviders(
  db: ServerContext["db"],
  orgId: string
): Promise<Array<{ id: string; label: string; defaultModel: string | null }>> {
  if (!process.env.CREDENTIAL_MASTER_KEY) {
    return [];
  }
  try {
    const manager = new CredentialManager(db);
    const creds = await manager.listCredentials(orgId);
    return creds
      // Only real LLM providers are selectable; internal pseudo-credentials
      // (e.g. bitbucket_threshold) live in the same table and must be excluded.
      .filter((cred) => Boolean(getProviderInfo(normalizeProviderId(cred.provider))))
      .map((cred) => ({
        id: cred.provider,
        label: providerLabel(cred.provider),
        defaultModel: providerDefaultModel(cred.provider)
      }));
  } catch {
    return [];
  }
}

// The credential catalog keys Anthropic as "claude" while the gateway stores
// "anthropic"; normalize so labels and default models resolve either way.
function normalizeProviderId(provider: string): string {
  return provider === "anthropic" ? "claude" : provider;
}

function providerLabel(provider: string): string {
  return getProviderInfo(normalizeProviderId(provider))?.label ?? provider;
}

function providerDefaultModel(provider: string): string | null {
  return getProviderInfo(normalizeProviderId(provider))?.defaultModel ?? null;
}

function normalizeGithubOwner(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Parse the common GitHub repo link forms into a canonical identity, rejecting
 * anything that is not a github.com repo. Accepts https URLs (with optional
 * .git suffix or trailing path), scp-style git@ URLs, "github.com/owner/repo",
 * and a bare "owner/repo" slug.
 */
export function parseRepoInput(raw: string): RepoIdentity | null {
  const input = raw.trim();
  if (!input) {
    return null;
  }

  let rest: string;

  const ssh = /^git@([^:]+):(.+)$/.exec(input);
  if (ssh) {
    if (ssh[1].toLowerCase() !== "github.com") {
      return null;
    }
    rest = ssh[2];
  } else if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") {
      return null;
    }
    rest = url.pathname;
  } else {
    rest = input.replace(/^(www\.)?github\.com\//i, "");
    // A leftover host-like first segment means a non-github URL was pasted.
    if (/^[^/]+\.[^/]+\//.test(rest)) {
      return null;
    }
  }

  const segments = rest.replace(/^\/+/, "").split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  // Match the slug shape GitHubScmProvider accepts (owner/name of [\w.-]).
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    return null;
  }

  const fullName = `${owner}/${repo}`;
  return { owner, repo, fullName, url: `https://github.com/${fullName}` };
}
