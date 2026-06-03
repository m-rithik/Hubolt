import type { AnalyzerProvider } from "../../types/providers.js";

const analyzers = new Map<string, () => AnalyzerProvider>();

export function registerAnalyzerProvider(name: string, makeProvider: () => AnalyzerProvider): void {
  analyzers.set(name, makeProvider);
}

export function getAnalyzerProvider(name: string): AnalyzerProvider {
  const makeProvider = analyzers.get(name);
  if (!makeProvider) {
    throw new Error(`Unknown analyzer provider: ${name}`);
  }

  return makeProvider();
}

export function listAnalyzerProviders(): string[] {
  return [...analyzers.keys()].sort();
}
