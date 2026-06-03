import { createHash } from "node:crypto";
import type { RepoConfig } from "../config/schema.js";
import type { Finding, LLMFinding } from "../types/finding.js";
import type { LLMProvider } from "../types/providers.js";
import type { BuiltContext } from "./context-builder.js";
import { buildReviewPrompt } from "./prompt.js";
import { dedupeFindings, filterByThreshold, rankFindings } from "./rank.js";

export interface ReviewResult {
  findings: Finding[];
  rawCount: number;
  droppedOutOfScope: number;
  belowThreshold: number;
}

export interface RunPipelineParams {
  context: BuiltContext;
  config: RepoConfig;
  llm: LLMProvider;
}

/**
 * Orchestrate a review: prompt -> LLM -> enrich -> scope/threshold filter ->
 * dedupe -> rank. The LLM is injected so the pipeline is testable with a fake.
 */
export async function runReviewPipeline(params: RunPipelineParams): Promise<ReviewResult> {
  const { context, config, llm } = params;

  const prompt = buildReviewPrompt(context, config);
  const raw = await llm.review({ system: prompt.system, user: prompt.user });

  const reviewablePaths = new Set(context.reviewable.map((file) => file.path));
  const enriched = raw.map(toFinding);
  const inScope = enriched.filter((finding) => reviewablePaths.has(finding.range.file));
  const passing = filterByThreshold(inScope, config.severityThreshold);
  const ranked = rankFindings(dedupeFindings(passing));

  return {
    findings: ranked,
    rawCount: raw.length,
    droppedOutOfScope: enriched.length - inScope.length,
    belowThreshold: inScope.length - passing.length
  };
}

export function toFinding(finding: LLMFinding): Finding {
  return {
    fingerprint: fingerprint(finding),
    ruleId: finding.ruleId,
    title: finding.title,
    message: finding.message,
    category: finding.category,
    severity: finding.severity,
    confidenceLabel: finding.confidenceLabel,
    source: "llm",
    range: finding.range,
    evidence: finding.evidence,
    impact: finding.impact,
    suggestion: finding.suggestion,
    verification: finding.verification,
    relatedSignals: [],
    tags: []
  };
}

function fingerprint(finding: LLMFinding): string {
  const basis = [
    finding.range.file,
    finding.ruleId,
    finding.category,
    finding.range.startLine,
    finding.range.endLine
  ].join("|");

  return `fp_${createHash("sha1").update(basis).digest("hex").slice(0, 16)}`;
}
