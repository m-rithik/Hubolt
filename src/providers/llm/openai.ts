import { createOpenAI } from "@ai-sdk/openai";
import type { LLMProvider, LLMProviderOptions } from "../../types/providers.js";
import { createAiSdkProvider } from "./ai-sdk.js";

export function makeOpenAIProvider(options: LLMProviderOptions): LLMProvider {
  const config = options.apiKey ? { apiKey: options.apiKey } : undefined;
  const openaiClient = createOpenAI(config);
  return createAiSdkProvider("openai", openaiClient(options.model));
}
