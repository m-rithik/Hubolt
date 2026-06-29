import type { PrismaClient } from "../../generated/prisma/index.js";
import { CredentialManager } from "./credential-manager.js";

/**
 * Org-level review settings for the dashboard: the active LLM provider/model and
 * the severity threshold. Per-repository API tokens and webhook secrets are NOT
 * here - they live on each named RepositoryIntegration (see
 * repository-integrations.ts).
 */

// ponytail: the severity threshold is a small per-org setting stored in the
// credential table to avoid a schema migration; promote to an org column if
// more review settings accrue. It is filtered out of the gateway view.
const REVIEW_THRESHOLD_KEY = "bitbucket_threshold";

export const SEVERITY_LEVELS = ["info", "low", "medium", "high", "critical"] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

export function isValidSeverity(level: string): level is SeverityLevel {
  return (SEVERITY_LEVELS as readonly string[]).includes(level);
}

function manager(db: PrismaClient): CredentialManager | null {
  // Encryption requires a master key; without it the stored setting is disabled.
  return process.env.CREDENTIAL_MASTER_KEY ? new CredentialManager(db) : null;
}

async function readStored(db: PrismaClient, orgId: string, provider: string): Promise<string | undefined> {
  const m = manager(db);
  if (!m) return undefined;
  try {
    const value = await m.getCredential(orgId, provider, { touchLastUsed: false });
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

// Providers the review can use, with the env var that supplies each key. The id
// is what getLLMProvider expects ("claude" for Anthropic). The review runner
// uses these env keys directly, so a gateway credential is not required.
const REVIEW_PROVIDERS = [
  { id: "claude", label: "Anthropic (Claude)", defaultModel: "claude-haiku-4-5-20251001", envKey: "ANTHROPIC_API_KEY" },
  { id: "openai", label: "OpenAI", defaultModel: "gpt-4.1-mini", envKey: "OPENAI_API_KEY" },
  { id: "google", label: "Google (Gemini)", defaultModel: "gemini-flash-latest", envKey: "GOOGLE_GENERATIVE_AI_API_KEY" }
] as const;

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

/** Stored severity threshold override, or undefined to use the repo .hubolt.yml. */
export async function getActiveReviewThreshold(db: PrismaClient, orgId: string): Promise<string | undefined> {
  return readStored(db, orgId, REVIEW_THRESHOLD_KEY);
}

/** Set the org's review severity threshold override. */
export async function setActiveReviewThreshold(
  db: PrismaClient,
  orgId: string,
  level: SeverityLevel
): Promise<void> {
  const m = manager(db);
  if (!m) {
    throw new Error("CREDENTIAL_MASTER_KEY is required to store the review threshold");
  }
  await m.storeCredential(orgId, REVIEW_THRESHOLD_KEY, level);
}
