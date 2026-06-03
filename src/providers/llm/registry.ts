import type { LLMProvider, LLMProviderOptions } from "../../types/providers.js";

export type LLMProviderFactory = (options: LLMProviderOptions) => LLMProvider;

const providers = new Map<string, LLMProviderFactory>();

export function registerLLMProvider(name: string, makeProvider: LLMProviderFactory): void {
  providers.set(name, makeProvider);
}

export function getLLMProvider(name: string, options: LLMProviderOptions): LLMProvider {
  const makeProvider = providers.get(name);
  if (!makeProvider) {
    throw new Error(`Unknown LLM provider: ${name}`);
  }

  return makeProvider(options);
}

export function listLLMProviders(): string[] {
  return [...providers.keys()].sort();
}
