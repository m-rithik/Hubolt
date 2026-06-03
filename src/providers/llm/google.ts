import { google } from "@ai-sdk/google";
import type { LLMProvider, LLMProviderOptions } from "../../types/providers.js";
import { createAiSdkProvider } from "./ai-sdk.js";

export function makeGoogleProvider(options: LLMProviderOptions): LLMProvider {
  return createAiSdkProvider("google", google(options.model));
}
