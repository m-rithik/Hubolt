import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { LLMFindingSchema } from "../../types/finding.js";
import type { LLMProvider, LLMProviderOptions } from "../../types/providers.js";

const ResponseSchema = z.object({
  findings: z.array(LLMFindingSchema)
});

/**
 * OpenAI provider backed by the Vercel AI SDK. Structured output is enforced by
 * generateObject against the finding schema. The API key is read from
 * OPENAI_API_KEY at call time, so constructing the provider never requires it.
 */
export function makeOpenAIProvider(options: LLMProviderOptions): LLMProvider {
  return {
    name: "openai",
    async review(request) {
      const { object } = await generateObject({
        model: openai(options.model),
        schema: ResponseSchema,
        system: request.system,
        prompt: request.user
      });

      return object.findings;
    }
  };
}
