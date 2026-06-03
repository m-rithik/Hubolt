import type { LLMProvider } from "../../types/providers.js";

const providers = new Map<string, () => LLMProvider>();

export function registerLLMProvider(name: string, makeProvider: () => LLMProvider): void {
  providers.set(name, makeProvider);
}

export function getLLMProvider(name: string): LLMProvider {
  const makeProvider = providers.get(name);
  if (!makeProvider) {
    throw new Error(`Unknown LLM provider: ${name}`);
  }

  return makeProvider();
}

export function listLLMProviders(): string[] {
  return [...providers.keys()].sort();
}
