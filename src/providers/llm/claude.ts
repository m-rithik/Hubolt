import { createAnthropic } from "@ai-sdk/anthropic";
import type { LLMProvider, LLMProviderOptions } from "../../types/providers.js";
import { createAiSdkProvider } from "./ai-sdk.js";

export function makeClaudeProvider(options: LLMProviderOptions): LLMProvider {
  const config = options.apiKey ? { apiKey: options.apiKey } : undefined;
  const anthropicClient = createAnthropic(config);
  return createAiSdkProvider("claude", anthropicClient(options.model));
}
