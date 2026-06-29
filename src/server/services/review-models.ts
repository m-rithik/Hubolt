import type { PrismaClient } from "../../generated/prisma/index.js";
import { getProviderInfo } from "../../providers/llm/catalog.js";
import { CredentialManager } from "./credential-manager.js";

export interface ReviewProviderInfo {
  id: string;
  label: string;
  defaultModel: string | null;
  /** True when this org has a gateway-stored API key for the provider. */
  keyPresent: boolean;
}

/** Providers the org has a gateway credential for, with label and default model. */
export async function listGatewayReviewProviders(
  db: PrismaClient,
  orgId: string
): Promise<ReviewProviderInfo[]> {
  if (!process.env.CREDENTIAL_MASTER_KEY) {
    return [];
  }
  try {
    const manager = new CredentialManager(db);
    const creds = await manager.listCredentials(orgId);
    return creds
      // Only real LLM providers are selectable; internal pseudo-credentials
      // such as bitbucket_threshold live in the same table and must be excluded.
      .filter((cred) => Boolean(getProviderInfo(normalizeReviewProviderId(cred.provider))))
      .map((cred) => ({
        id: cred.provider,
        label: providerLabel(cred.provider),
        defaultModel: providerDefaultModel(cred.provider),
        keyPresent: true
      }));
  } catch {
    return [];
  }
}

export function isKnownReviewProvider(id: string): boolean {
  return Boolean(getProviderInfo(normalizeReviewProviderId(id)));
}

export function normalizeReviewProviderId(provider: string): string {
  return provider === "anthropic" ? "claude" : provider;
}

function providerLabel(provider: string): string {
  return getProviderInfo(normalizeReviewProviderId(provider))?.label ?? provider;
}

function providerDefaultModel(provider: string): string | null {
  return getProviderInfo(normalizeReviewProviderId(provider))?.defaultModel ?? null;
}
