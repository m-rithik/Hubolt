import type { Finding, ReviewRange, Severity } from "./finding.js";
import type { ReviewContext } from "./review-context.js";

export interface AnalyzerSignal {
  id: string;
  analyzer: string;
  ruleId: string;
  range: ReviewRange;
  severity: Severity;
  message: string;
  evidence: string[];
  raw?: unknown;
}

export interface PromptConfig {
  system: string;
  behaviorPack?: string;
}

export interface LLMReviewInput {
  context: ReviewContext;
  prompt: string;
}

export interface LLMProvider {
  readonly name: string;
  review(input: LLMReviewInput, cfg: PromptConfig): Promise<Finding[]>;
}

export interface AnalyzerProvider {
  readonly name: string;
  isAvailable(ctx: ReviewContext): Promise<boolean>;
  analyze(ctx: ReviewContext): Promise<AnalyzerSignal[]>;
}
