import { describe, expect, test } from "vitest";
import { PROVIDERS, getProviderInfo } from "../../src/providers/llm/catalog.js";
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

  test("all catalog providers are registered in the LLM registry", () => {
    const registered = listLLMProviders();
    for (const provider of PROVIDERS) {
      expect(registered).toContain(provider.id);
    }
  });
});
