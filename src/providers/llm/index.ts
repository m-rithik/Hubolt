import { makeOpenAIProvider } from "./openai.js";
import { registerLLMProvider } from "./registry.js";

registerLLMProvider("openai", makeOpenAIProvider);

export { getLLMProvider, listLLMProviders, registerLLMProvider } from "./registry.js";
export { makeOpenAIProvider } from "./openai.js";
