import { describe, expect, test } from "vitest";
import {
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER_ID,
  PROVIDERS,
  getProviderInfo
} from "../../src/providers/llm/catalog.js";
import { listLLMProviders } from "../../src/providers/llm/index.js";

describe("provider catalog", () => {
  test("offers openai, claude, and google with key env vars", () => {
    expect(PROVIDERS.map((provider) => provider.id)).toEqual(["openai", "claude", "google"]);
    expect(getProviderInfo("claude")?.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(getProviderInfo("google")?.apiKeyEnv).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(getProviderInfo("openai")?.apiKeyEnv).toBe("OPENAI_API_KEY");
  });

  test("returns undefined for an unknown provider", () => {
    expect(getProviderInfo("nope")).toBeUndefined();
  });

  test("default LLM provider and model resolve through the catalog", () => {
    const provider = getProviderInfo(DEFAULT_LLM_PROVIDER_ID);

    expect(provider).toBeDefined();
    expect(provider?.defaultModel).toBe(DEFAULT_LLM_MODEL);
  });

  test("all catalog providers are registered in the LLM registry", () => {
    const registered = listLLMProviders();
    for (const provider of PROVIDERS) {
      expect(registered).toContain(provider.id);
    }
  });
});
