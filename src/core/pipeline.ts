import { createHash } from "node:crypto";
import type { RepoConfig } from "../config/schema.js";
import type { ChangedRange } from "./diff.js";
import {
  CONTEXT_ADJACENT_TAG,
  FindingSchema,
  LLMFindingSchema,
  type Finding,
  type LLMFinding
} from "../types/finding.js";
import type { LLMProvider } from "../types/providers.js";
import type { BuiltContext } from "./context-builder.js";
import { buildReviewPrompt } from "./prompt.js";
import { dedupeFindings, filterByThreshold, rankFindings } from "./rank.js";

export interface ReviewResult {
  findings: Finding[];
  rawCount: number;
  droppedInvalid: number;
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

  // The LLM schema is intentionally loose for strict structured output, so each
  // candidate is re-validated against the full FindingSchema (positive, ordered
  // ranges; non-empty evidence) before it can reach output. Invalid ones drop.
  const rangesByPath = new Map<string, ChangedRange[]>(
    context.reviewable.map((file) => [file.path, file.changedRanges])
  );

  let droppedInvalid = 0;
  const enriched: Finding[] = [];
  for (const candidate of raw) {
    const llmParsed = LLMFindingSchema.safeParse(candidate);
    if (!llmParsed.success) {
      droppedInvalid += 1;
      continue;
    }

    const parsed = FindingSchema.safeParse(toFinding(llmParsed.data));
    if (!parsed.success) {
      droppedInvalid += 1;
      continue;
    }
    enriched.push(tagScope(parsed.data, rangesByPath));
  }

  const reviewablePaths = new Set(context.reviewable.map((file) => file.path));
  const inScope = enriched.filter((finding) => reviewablePaths.has(finding.range.file));
  const passing = filterByThreshold(inScope, config.severityThreshold);
  const ranked = rankFindings(dedupeFindings(passing));

  return {
    findings: ranked,
    rawCount: raw.length,
    droppedInvalid,
    droppedOutOfScope: enriched.length - inScope.length,
    belowThreshold: inScope.length - passing.length
  };
}

/**
 * Tag a finding as context-adjacent when its range does not overlap any changed
 * line range for that file. Full-file changes (no ranges) are never tagged.
 * Tagging rather than dropping keeps valid findings about how a change affects
 * nearby code, while letting ranking and output de-emphasize them.
 */
function tagScope(finding: Finding, rangesByPath: Map<string, ChangedRange[]>): Finding {
  const ranges = rangesByPath.get(finding.range.file);
  if (!ranges || ranges.length === 0) {
    return finding;
  }

  const { startLine, endLine } = finding.range;
  const overlaps = ranges.some((range) => startLine <= range.endLine && range.startLine <= endLine);
  if (overlaps) {
    return finding;
  }

  return { ...finding, tags: [...finding.tags, CONTEXT_ADJACENT_TAG] };
}

export function toFinding(finding: LLMFinding): Finding {
  const suggestion = finding.suggestion.trim();

  return {
    fingerprint: fingerprint(finding),
    ruleId: finding.ruleId,
    title: finding.title,
    message: finding.message,
    category: finding.category,
    severity: finding.severity,
    confidenceLabel: finding.confidenceLabel,
    source: "llm",
    range: {
      file: finding.range.file,
      startLine: finding.range.startLine,
      endLine: finding.range.endLine,
      diffSide: "right"
    },
    evidence: finding.evidence,
    impact: finding.impact,
    suggestion: suggestion.length > 0 ? suggestion : undefined,
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
