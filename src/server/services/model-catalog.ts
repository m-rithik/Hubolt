// Single source of truth for the models the gateway can route to.
//
// The router, cost estimator, and the public /gateway/models route all read
// from here so the advertised models, the routable models, and the priced
// models cannot drift apart.
//
// costPer1kTokens is an approximate blended input rate (USD per 1k tokens)
// used for routing decisions and budget estimation, not for billing.

export interface ModelInfo {
  displayName: string;
  costPer1kTokens: number;
  quality: number;
  latency: number;
  available: boolean;
}

export type ProviderName = "anthropic" | "openai" | "google";

export const MODEL_CATALOG: Record<ProviderName, Record<string, ModelInfo>> = {
  anthropic: {
    "claude-opus-4-8": {
      displayName: "Claude Opus 4.8 (Most Capable)",
      costPer1kTokens: 0.005,
      quality: 10,
      latency: 2000,
      available: true
    },
    "claude-sonnet-4-6": {
      displayName: "Claude Sonnet 4.6 (Balanced)",
      costPer1kTokens: 0.003,
      quality: 8,
      latency: 1000,
      available: true
    },
    "claude-haiku-4-5": {
      displayName: "Claude Haiku 4.5 (Fast & Cheap)",
      costPer1kTokens: 0.001,
      quality: 6,
      latency: 400,
      available: true
    }
  },
  openai: {
    "gpt-4o": {
      displayName: "GPT-4o",
      costPer1kTokens: 0.0025,
      quality: 9,
      latency: 1500,
      available: true
    },
    "gpt-4-turbo": {
      displayName: "GPT-4 Turbo",
      costPer1kTokens: 0.01,
      quality: 8,
      latency: 2000,
      available: true
    },
    "gpt-4o-mini": {
      displayName: "GPT-4o Mini (Cheap)",
      costPer1kTokens: 0.00015,
      quality: 6,
      latency: 800,
      available: true
    }
  },
  google: {
    "gemini-2.5-flash": {
      displayName: "Gemini 2.5 Flash",
      costPer1kTokens: 0.000075,
      quality: 8,
      latency: 1200,
      available: true
    },
    "gemini-2.5-pro": {
      displayName: "Gemini 2.5 Pro",
      costPer1kTokens: 0.00375,
      quality: 9,
      latency: 2000,
      available: true
    }
  }
};

/** Look up a single model's pricing/quality info, or null if uncataloged. */
export function getModelInfo(provider: string, model: string): ModelInfo | null {
  const providerCatalog = MODEL_CATALOG[provider as ProviderName];
  if (!providerCatalog) {
    return null;
  }
  return providerCatalog[model] ?? null;
}

/** The full catalog, keyed by provider then model id. */
export function listAvailableModels(): Record<ProviderName, Record<string, ModelInfo>> {
  return MODEL_CATALOG;
}
