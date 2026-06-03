import { openai } from "@ai-sdk/openai";
import type { LLMProvider, LLMProviderOptions } from "../../types/providers.js";
import { createAiSdkProvider } from "./ai-sdk.js";

export function makeOpenAIProvider(options: LLMProviderOptions): LLMProvider {
  return createAiSdkProvider("openai", openai(options.model));
}
