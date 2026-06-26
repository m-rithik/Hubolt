import type { PrismaClient } from "../../generated/prisma/index.js";
import { CredentialManager } from "./credential-manager.js";

/**
 * Bitbucket configuration storage and resolution. Secrets entered in the
 * dashboard are stored encrypted (via CredentialManager) under these provider
 * keys; reads prefer the stored value and fall back to the environment so an
 * existing .env setup keeps working. The webhook secret and API token are kept
 * out of the LLM gateway's credential list (see llm-gateway.getStatus).
 */
export const BITBUCKET_TOKEN_KEY = "bitbucket";
export const BITBUCKET_WEBHOOK_SECRET_KEY = "bitbucket_webhook";

export type BitbucketField = "token" | "secret";

function fieldToProvider(field: BitbucketField): string {
  return field === "token" ? BITBUCKET_TOKEN_KEY : BITBUCKET_WEBHOOK_SECRET_KEY;
}

function manager(db: PrismaClient): CredentialManager | null {
  // Encryption requires a master key; without it the stored path is disabled
  // and only the environment fallback applies.
  return process.env.CREDENTIAL_MASTER_KEY ? new CredentialManager(db) : null;
}

async function readStored(db: PrismaClient, orgId: string, provider: string): Promise<string | undefined> {
  const m = manager(db);
  if (!m) return undefined;
  try {
    const value = await m.getCredential(orgId, provider, { touchLastUsed: false });
    return value ?? undefined;
  } catch {
    // A decryption failure must not break the webhook; fall back to env.
    return undefined;
  }
}

/** API token: stored value first, then BITBUCKET_API_TOKEN. */
export async function getBitbucketToken(db: PrismaClient, orgId: string): Promise<string | undefined> {
  return (await readStored(db, orgId, BITBUCKET_TOKEN_KEY)) ?? process.env.BITBUCKET_API_TOKEN ?? undefined;
}

/** Webhook secret: stored value first, then BITBUCKET_WEBHOOK_SECRET. */
export async function getBitbucketWebhookSecret(db: PrismaClient, orgId: string): Promise<string | undefined> {
  return (await readStored(db, orgId, BITBUCKET_WEBHOOK_SECRET_KEY)) ?? process.env.BITBUCKET_WEBHOOK_SECRET ?? undefined;
}

/** Store a Bitbucket secret encrypted at rest. Requires CREDENTIAL_MASTER_KEY. */
export async function storeBitbucketField(
  db: PrismaClient,
  orgId: string,
  field: BitbucketField,
  value: string
): Promise<void> {
  const m = manager(db);
  if (!m) {
    throw new Error("CREDENTIAL_MASTER_KEY is required to store Bitbucket credentials");
  }
  await m.storeCredential(orgId, fieldToProvider(field), value);
}

/** Remove a stored Bitbucket secret (the env fallback, if any, still applies). */
export async function clearBitbucketField(db: PrismaClient, orgId: string, field: BitbucketField): Promise<void> {
  const m = manager(db);
  if (!m) return;
  await m.deleteCredential(orgId, fieldToProvider(field));
}

export interface BitbucketConfigStatus {
  tokenConfigured: boolean;
  webhookSecretConfigured: boolean;
  /** True when the value comes from the environment rather than stored config. */
  tokenFromEnv: boolean;
  webhookSecretFromEnv: boolean;
}

/** Configuration status for the dashboard. Never returns the secret values. */
export async function getBitbucketConfigStatus(db: PrismaClient, orgId: string): Promise<BitbucketConfigStatus> {
  const storedToken = await readStored(db, orgId, BITBUCKET_TOKEN_KEY);
  const storedSecret = await readStored(db, orgId, BITBUCKET_WEBHOOK_SECRET_KEY);
  return {
    tokenConfigured: Boolean(storedToken ?? process.env.BITBUCKET_API_TOKEN),
    webhookSecretConfigured: Boolean(storedSecret ?? process.env.BITBUCKET_WEBHOOK_SECRET),
    tokenFromEnv: !storedToken && Boolean(process.env.BITBUCKET_API_TOKEN),
    webhookSecretFromEnv: !storedSecret && Boolean(process.env.BITBUCKET_WEBHOOK_SECRET)
  };
}

/** Resolve the webhook secret for the active (first) org. */
export async function getActiveBitbucketWebhookSecret(db: PrismaClient): Promise<string | undefined> {
  const org = await db.organization.findFirst();
  if (!org) return process.env.BITBUCKET_WEBHOOK_SECRET ?? undefined;
  return getBitbucketWebhookSecret(db, org.id);
}

/** True when an API token is available (stored or env) for the active org. */
export async function isBitbucketConfigured(db: PrismaClient): Promise<boolean> {
  const org = await db.organization.findFirst();
  if (!org) return Boolean(process.env.BITBUCKET_API_TOKEN);
  return Boolean(await getBitbucketToken(db, org.id));
}

// Providers the review can use, with the env var that supplies each key. The id
// is what getLLMProvider expects ("claude" for Anthropic). The Bitbucket review
// runner uses these env keys directly, so a gateway credential is not required.
const REVIEW_PROVIDERS = [
  { id: "claude", label: "Anthropic (Claude)", defaultModel: "claude-haiku-4-5-20251001", envKey: "ANTHROPIC_API_KEY" },
  { id: "openai", label: "OpenAI", defaultModel: "gpt-4.1-mini", envKey: "OPENAI_API_KEY" },
  { id: "google", label: "Google (Gemini)", defaultModel: "gemini-flash-latest", envKey: "GOOGLE_GENERATIVE_AI_API_KEY" }
] as const;

export type ReviewProviderId = (typeof REVIEW_PROVIDERS)[number]["id"];

export interface ReviewProviderInfo {
  id: string;
  label: string;
  defaultModel: string;
  /** True when this provider's API key is present in the environment. */
  keyPresent: boolean;
}

/** The selectable review providers and whether each has a usable key. */
export function listReviewProviders(): ReviewProviderInfo[] {
  return REVIEW_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    defaultModel: p.defaultModel,
    keyPresent: Boolean(process.env[p.envKey])
  }));
}

export function isKnownReviewProvider(id: string): boolean {
  return REVIEW_PROVIDERS.some((p) => p.id === id);
}

/** The org's currently active review provider/model (the one reviews use). */
export async function getActiveReviewModel(
  db: PrismaClient,
  orgId: string
): Promise<{ provider: string | null; model: string | null }> {
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { reviewLlmProvider: true, reviewLlmModel: true }
  });
  return { provider: org?.reviewLlmProvider ?? null, model: org?.reviewLlmModel ?? null };
}

/** Set the active review provider/model for the org. */
export async function setActiveReviewModel(
  db: PrismaClient,
  orgId: string,
  provider: string,
  model: string
): Promise<void> {
  await db.organization.update({
    where: { id: orgId },
    data: { reviewLlmProvider: provider, reviewLlmModel: model }
  });
}
