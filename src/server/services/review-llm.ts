import type { PrismaClient } from "../../generated/prisma/index.js";
import { getLLMProvider } from "../../providers/llm/index.js";
import type { LLMProvider } from "../../types/providers.js";
import { CredentialManager } from "./credential-manager.js";

/**
 * Build a hosted review LLM from the org's gateway-stored credential when one
 * exists. With no stored credential, provider factories may still use their
 * environment variable for single-tenant/local deployments.
 */
export async function createHostedReviewLlm(
  db: PrismaClient,
  orgId: string,
  provider: string,
  model: string
): Promise<LLMProvider> {
  const apiKey = await resolveGatewayApiKey(db, orgId, provider);
  return getLLMProvider(provider, { model, apiKey });
}

/**
 * The org's gateway-stored API key for a provider, or undefined to let the
 * provider factory use its env var.
 *
 * Fail closed in hosted mode: getCredential returns null when the org has no
 * credential for this provider, but throws when a stored credential cannot be
 * decrypted. Letting that error propagate avoids silently using the operator's
 * environment key and billing the wrong account.
 */
export async function resolveGatewayApiKey(
  db: PrismaClient,
  orgId: string,
  provider: string
): Promise<string | undefined> {
  if (!process.env.CREDENTIAL_MASTER_KEY) {
    return undefined;
  }

  const manager = new CredentialManager(db);
  for (const candidate of gatewayCredentialCandidates(provider)) {
    const key = await manager.getCredential(orgId, candidate, { touchLastUsed: true });
    if (key) return key;
  }
  return undefined;
}

function gatewayCredentialCandidates(provider: string): string[] {
  if (provider === "claude") return ["claude", "anthropic"];
  if (provider === "anthropic") return ["anthropic", "claude"];
  return [provider];
}
