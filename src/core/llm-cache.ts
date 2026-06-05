import { LLMFindingSchema, type LLMFinding } from "../types/finding.js";
import type { LLMProvider } from "../types/providers.js";
import { cacheKey, type Cache } from "./cache.js";
import { PROMPT_VERSION } from "./prompt.js";

/**
 * Wrap an LLM provider so identical review requests reuse cached findings. The
 * key covers prompt version, provider, model, and the full prompt text, so any
 * change to inputs misses the cache. Skips the model call (and its cost) on a
 * hit. A code change that alters the prompt requires bumping PROMPT_VERSION.
 */
export function withLlmCache(provider: LLMProvider, cache: Cache, model: string): LLMProvider {
  return {
    name: provider.name,
    async review(request) {
      const key = cacheKey([
        "llm",
        PROMPT_VERSION,
        provider.name,
        model,
        normalizePromptForCache(request.system ?? ""),
        normalizePromptForCache(request.user ?? "")
      ]);
      const cached = readCachedFindings(cache, key);
      if (cached) {
        return cached;
      }
      const result = await provider.review(request);
      cache.set(key, result);
      return result;
    }
  };
}

function readCachedFindings(cache: Cache, key: string): LLMFinding[] | null {
  const cached = cache.get<unknown>(key);
  if (!Array.isArray(cached)) {
    return null;
  }

  const findings: LLMFinding[] = [];
  for (const finding of cached) {
    const parsed = LLMFindingSchema.safeParse(finding);
    if (!parsed.success) {
      return null;
    }
    findings.push(parsed.data);
  }
  return findings;
}

function normalizePromptForCache(prompt: string): string {
  return prompt.replace(/\b(?:BEGIN|END)_UNTRUSTED_[a-f0-9]{18}\b/g, (marker) =>
    marker.startsWith("BEGIN") ? "BEGIN_UNTRUSTED_CACHE_BOUNDARY" : "END_UNTRUSTED_CACHE_BOUNDARY"
  );
}
