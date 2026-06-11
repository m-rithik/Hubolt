import { makeClaudeProvider } from "./claude.js";
import { makeGoogleProvider } from "./google.js";
import { makeOpenAIProvider } from "./openai.js";
import { registerLLMProvider } from "./registry.js";

registerLLMProvider("openai", makeOpenAIProvider);
registerLLMProvider("claude", makeClaudeProvider);
registerLLMProvider("anthropic", makeClaudeProvider);
registerLLMProvider("google", makeGoogleProvider);

export { getLLMProvider, listLLMProviders, registerLLMProvider } from "./registry.js";
export { PROVIDERS, getProviderInfo, type ProviderInfo } from "./catalog.js";
export { makeOpenAIProvider } from "./openai.js";
export { makeClaudeProvider } from "./claude.js";
export { makeGoogleProvider } from "./google.js";
