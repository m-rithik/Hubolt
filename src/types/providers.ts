import type { LLMFinding, ReviewRange, Severity } from "./finding.js";
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

export interface LLMReviewRequest {
  system: string;
  user: string;
}

export interface LLMProviderOptions {
  model: string;
}

export interface LLMProvider {
  readonly name: string;
  review(request: LLMReviewRequest): Promise<LLMFinding[]>;
}

export interface AnalyzerProvider {
  readonly name: string;
  isAvailable(ctx: ReviewContext): Promise<boolean>;
  analyze(ctx: ReviewContext): Promise<AnalyzerSignal[]>;
}
