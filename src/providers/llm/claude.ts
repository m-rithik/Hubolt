import { anthropic } from "@ai-sdk/anthropic";
import type { LLMProvider, LLMProviderOptions } from "../../types/providers.js";
import { createAiSdkProvider } from "./ai-sdk.js";

export function makeClaudeProvider(options: LLMProviderOptions): LLMProvider {
  return createAiSdkProvider("claude", anthropic(options.model));
}
