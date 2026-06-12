import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { LLMFindingSchema } from "../../types/finding.js";
import type { LLMProvider } from "../../types/providers.js";

const ResponseSchema = z.object({
  findings: z.array(LLMFindingSchema)
});

/**
 * Wrap any Vercel AI SDK model in the Hubolt LLMProvider contract. Structured
 * output is enforced by generateObject against the strict finding schema, so
 * every provider returns the same shape. API keys are read from the provider's
 * environment variable at call time.
 */
export function createAiSdkProvider(name: string, model: LanguageModel): LLMProvider {
  return {
    name,
    async review(request) {
      const { object, usage } = await generateObject({
        model,
        schema: ResponseSchema,
        system: request.system,
        prompt: request.user
      });

      if (request.onUsage) {
        const reported = normalizeUsage(usage);
        if (reported) {
          request.onUsage(reported);
        }
      }

      return object.findings;
    }
  };
}

/**
 * The AI SDK has renamed usage fields across majors (promptTokens vs
 * inputTokens); read both shapes and report only when real numbers exist.
 */
function normalizeUsage(usage: unknown): { inputTokens: number; outputTokens: number } | null {
  if (!usage || typeof usage !== "object") return null;
  const raw = usage as Record<string, unknown>;
  const input = raw.inputTokens ?? raw.promptTokens;
  const output = raw.outputTokens ?? raw.completionTokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { inputTokens: input, outputTokens: output };
}
