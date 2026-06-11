import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LLMProvider, LLMProviderOptions } from "../../types/providers.js";
import { createAiSdkProvider } from "./ai-sdk.js";

export function makeGoogleProvider(options: LLMProviderOptions): LLMProvider {
  const config = options.apiKey ? { apiKey: options.apiKey } : undefined;
  const googleClient = createGoogleGenerativeAI(config);
  return createAiSdkProvider("google", googleClient(options.model));
}
