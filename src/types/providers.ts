import type { AnalyzerSignal, LLMFinding } from "./finding.js";
import type { ChangedRange } from "../core/diff.js";
import type { RepoConfig } from "../config/schema.js";

export type { AnalyzerSignal } from "./finding.js";

/** Token consumption reported by the underlying model API. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMReviewRequest {
  system: string;
  user: string;
  /**
   * Invoked with real token usage when the provider reports it. Optional and
   * additive: providers that cannot report usage simply never call it.
   */
  onUsage?: (usage: TokenUsage) => void;
}

export interface LLMProviderOptions {
  model: string;
  apiKey?: string;
}

export interface LLMProvider {
  readonly name: string;
  review(request: LLMReviewRequest): Promise<LLMFinding[]>;
}

/** A single changed file made available to analyzers. */
export interface AnalyzerFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  content: string;
  changedRanges: ChangedRange[];
}

/**
 * The input analyzers receive. Deliberately lean: just the repository root, the
 * changed files with content and ranges, and the resolved config. This keeps
 * analyzers decoupled from PR/SCM context, which arrives in later phases.
 */
export interface AnalyzerContext {
  repoRoot: string;
  files: AnalyzerFile[];
  config: RepoConfig;
}

export interface AnalyzerProvider {
  readonly name: string;
  isAvailable(ctx: AnalyzerContext): Promise<boolean>;
  analyze(ctx: AnalyzerContext): Promise<AnalyzerSignal[]>;
}
