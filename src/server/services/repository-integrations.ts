import type { PrismaClient } from "../../generated/prisma/index.js";
import { encryptSecret, decryptSecret, secretFingerprint } from "../crypto/secret-box.js";

/**
 * Named per-repository integrations: one repo links to exactly one API token and
 * one webhook secret, under an admin-given name (e.g. "Payments Service
 * Bitbucket Connection"). Secrets are encrypted at rest; their sha256
 * fingerprints are unique columns so the same token or secret cannot be reused
 * by another integration. This replaces the old per-org Bitbucket credentials.
 */

export class IntegrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationConflictError";
  }
}

export interface IntegrationInput {
  orgId: string;
  repoId: string;
  provider: string; // "github" | "bitbucket"
  name: string;
  token: string;
  webhookSecret?: string;
  /** Optional per-repo Slack incoming webhook URL. */
  slackWebhookUrl?: string;
  createdById?: string;
}

export interface MaskedIntegration {
  id: string;
  repoId: string;
  repoFullName?: string;
  provider: string;
  name: string;
  tokenLast4: string;
  webhookSecretConfigured: boolean;
  slackConfigured: boolean;
  createdAt: Date;
}

/** Resolved plaintext secrets for one repo's integration (server-side use only). */
export interface ResolvedIntegration {
  orgId: string;
  repoId: string;
  name: string;
  token: string;
  webhookSecret?: string;
  slackWebhookUrl?: string;
}

interface IntegrationRow {
  orgId: string;
  repoId: string;
  name: string;
  encryptedToken: string;
  encryptedWebhookSecret: string | null;
  encryptedSlackWebhook: string | null;
}

function decryptRow(row: IntegrationRow): ResolvedIntegration {
  return {
    orgId: row.orgId,
    repoId: row.repoId,
    name: row.name,
    token: decryptSecret(row.encryptedToken),
    webhookSecret: row.encryptedWebhookSecret ? decryptSecret(row.encryptedWebhookSecret) : undefined,
    slackWebhookUrl: row.encryptedSlackWebhook ? decryptSecret(row.encryptedSlackWebhook) : undefined
  };
}

/**
 * All integrations across all orgs whose repo full name matches. Used by the
 * Bitbucket webhook to resolve the correct tenant by verifying the signature
 * against each candidate's secret, rather than assuming the first org.
 */
export async function findIntegrationsByRepoFullName(
  db: PrismaClient,
  fullName: string
): Promise<ResolvedIntegration[]> {
  const rows = await db.repositoryIntegration.findMany({ where: { repo: { fullName } } });
  return rows.map((row) =>
    decryptRow({
      orgId: row.orgId,
      repoId: row.repoId,
      name: row.name,
      encryptedToken: row.encryptedToken,
      encryptedWebhookSecret: row.encryptedWebhookSecret,
      encryptedSlackWebhook: row.encryptedSlackWebhook
    })
  );
}

/**
 * Create or replace the integration for a repo. Enforces one-per-repo (the
 * unique repoId) and that neither the token nor the webhook secret is already
 * used by a different integration.
 */
export async function upsertIntegration(db: PrismaClient, input: IntegrationInput) {
  const tokenFingerprint = secretFingerprint(input.token);
  const tokenLast4 = input.token.slice(-4);
  const webhookSecretFingerprint = input.webhookSecret ? secretFingerprint(input.webhookSecret) : null;

  const tokenClash = await db.repositoryIntegration.findFirst({
    where: { tokenFingerprint, repoId: { not: input.repoId } },
    select: { id: true }
  });
  if (tokenClash) {
    throw new IntegrationConflictError("This API token is already used by another integration");
  }

  if (webhookSecretFingerprint) {
    const secretClash = await db.repositoryIntegration.findFirst({
      where: { webhookSecretFingerprint, repoId: { not: input.repoId } },
      select: { id: true }
    });
    if (secretClash) {
      throw new IntegrationConflictError("This webhook secret is already used by another integration");
    }
  }

  const encryptedToken = encryptSecret(input.token);
  const encryptedWebhookSecret = input.webhookSecret ? encryptSecret(input.webhookSecret) : null;
  const encryptedSlackWebhook = input.slackWebhookUrl ? encryptSecret(input.slackWebhookUrl) : null;

  return db.repositoryIntegration.upsert({
    where: { repoId: input.repoId },
    create: {
      orgId: input.orgId,
      repoId: input.repoId,
      provider: input.provider,
      name: input.name,
      encryptedToken,
      tokenFingerprint,
      tokenLast4,
      encryptedWebhookSecret,
      webhookSecretFingerprint,
      encryptedSlackWebhook,
      createdById: input.createdById ?? null
    },
    update: {
      provider: input.provider,
      name: input.name,
      encryptedToken,
      tokenFingerprint,
      tokenLast4,
      encryptedWebhookSecret,
      webhookSecretFingerprint,
      encryptedSlackWebhook
    }
  });
}

/** List integrations for an org, masked (never returns secret values). */
export async function listIntegrations(db: PrismaClient, orgId: string): Promise<MaskedIntegration[]> {
  const rows = await db.repositoryIntegration.findMany({
    where: { orgId },
    include: { repo: { select: { fullName: true } } },
    orderBy: { createdAt: "desc" }
  });
  return rows.map((row) => ({
    id: row.id,
    repoId: row.repoId,
    repoFullName: row.repo?.fullName,
    provider: row.provider,
    name: row.name,
    tokenLast4: typeof row.tokenLast4 === "string" ? row.tokenLast4 : "",
    webhookSecretConfigured: Boolean(row.encryptedWebhookSecret),
    slackConfigured: Boolean(row.encryptedSlackWebhook),
    createdAt: row.createdAt
  }));
}

/** Resolve a repo's integration secrets by repo full name (for webhook + review). */
export async function resolveIntegrationByRepoFullName(
  db: PrismaClient,
  orgId: string,
  fullName: string
): Promise<ResolvedIntegration | null> {
  const repo = await db.repository.findFirst({ where: { orgId, fullName }, select: { id: true } });
  if (!repo) return null;
  const integ = await db.repositoryIntegration.findUnique({ where: { repoId: repo.id } });
  if (!integ) return null;
  return {
    orgId,
    repoId: repo.id,
    name: integ.name,
    token: decryptSecret(integ.encryptedToken),
    webhookSecret: integ.encryptedWebhookSecret ? decryptSecret(integ.encryptedWebhookSecret) : undefined,
    slackWebhookUrl: integ.encryptedSlackWebhook ? decryptSecret(integ.encryptedSlackWebhook) : undefined
  };
}

export async function deleteIntegration(db: PrismaClient, orgId: string, repoId: string): Promise<void> {
  await db.repositoryIntegration.deleteMany({ where: { orgId, repoId } });
}
