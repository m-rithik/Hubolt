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
      const { object } = await generateObject({
        model,
        schema: ResponseSchema,
        system: request.system,
        prompt: request.user
      });

      return object.findings;
    }
  };
}
