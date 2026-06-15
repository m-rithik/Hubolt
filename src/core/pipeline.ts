import { createHash } from "node:crypto";
import type { RepoConfig } from "../config/schema.js";
import type { ChangedRange } from "./diff.js";
import {
  CONTEXT_ADJACENT_TAG,
  FindingSchema,
  LLMFindingSchema,
  type AnalyzerSignal,
  type Finding,
  type FindingCategory,
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
  droppedByMode: number;
  analyzerSignals: number;
  promotedFromAnalyzers: number;
  /** Real token usage from the model API, when the provider reported it. */
  usage?: { inputTokens: number; outputTokens: number };
}

/** Finding categories kept when running in security mode. */
const SECURITY_CATEGORIES = new Set<FindingCategory>(["security"]);

export interface RunPipelineParams {
  context: BuiltContext;
  config: RepoConfig;
  llm: LLMProvider;
  analyzerSignals?: AnalyzerSignal[];
  /** Compact team memory cards injected into the prompt, fenced as data. */
  memory?: string[];
}

/**
 * Orchestrate a review: prompt -> LLM -> enrich -> scope/threshold filter ->
 * dedupe -> rank. The LLM is injected so the pipeline is testable with a fake.
 */
export async function runReviewPipeline(params: RunPipelineParams): Promise<ReviewResult> {
  const { context, config, llm } = params;
  const analyzerSignals = params.analyzerSignals ?? [];

  const prompt = buildReviewPrompt(context, config, analyzerSignals, params.memory ?? []);
  let usage: ReviewResult["usage"];
  const raw = await llm.review({
    system: prompt.system,
    user: prompt.user,
    onUsage: (reported) => {
      usage = reported;
    }
  });

  // The LLM schema is intentionally loose for strict structured output, so each
  // candidate is re-validated against the full FindingSchema (positive, ordered
  // ranges; non-empty evidence) before it can reach output. Invalid ones drop.
  const rangesByPath = new Map<string, ChangedRange[]>(
    context.reviewable.map((file) => [file.path, file.changedRanges])
  );

  let droppedInvalid = 0;
  const llmFindings: Finding[] = [];
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
    llmFindings.push(parsed.data);
  }

  // Promote analyzer signals the LLM did not already triage. A signal is
  // "claimed" when an LLM finding lists its id in relatedSignals; the model's
  // explanation supersedes raw promotion there. Unclaimed deterministic signals
  // still surface so nothing is silently lost.
  const claimed = new Set<string>();
  for (const finding of llmFindings) {
    for (const id of finding.relatedSignals) {
      claimed.add(id);
    }
  }
  const promoted: Finding[] = [];
  for (const signal of analyzerSignals) {
    if (!claimed.has(signal.id)) {
      promoted.push(promoteSignal(signal));
    }
  }

  const enriched = [...llmFindings, ...promoted].map((finding) => tagScope(finding, rangesByPath));

  const reviewablePaths = new Set(context.reviewable.map((file) => file.path));
  const inScope = enriched.filter((finding) => reviewablePaths.has(finding.range.file));
  const passing = filterByThreshold(inScope, config.severityThreshold);

  // In security mode only security-relevant findings are in scope; everything
  // else is dropped here (it would move to a summary once reports land).
  const inMode =
    config.mode === "security" ? passing.filter((finding) => SECURITY_CATEGORIES.has(finding.category)) : passing;

  const ranked = rankFindings(dedupeFindings(inMode));

  return {
    findings: ranked,
    rawCount: raw.length,
    droppedInvalid,
    droppedOutOfScope: enriched.length - inScope.length,
    belowThreshold: inScope.length - passing.length,
    droppedByMode: passing.length - inMode.length,
    analyzerSignals: analyzerSignals.length,
    promotedFromAnalyzers: promoted.length,
    ...(usage ? { usage } : {})
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
    relatedSignals: finding.relatedSignals,
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

/** Category assigned to a promoted analyzer finding, keyed by analyzer name. */
const ANALYZER_CATEGORY: Record<string, FindingCategory> = {
  "secret-scan": "security",
  semgrep: "security",
  "dependency-audit": "security",
  typescript: "quality",
  eslint: "bestPractice"
};

/** Verification hint for a promoted analyzer finding, keyed by analyzer name. */
const ANALYZER_VERIFICATION: Record<string, string> = {
  "secret-scan": "Confirm the value is a real secret, rotate it, and move it to an environment variable.",
  typescript: "Run tsc to reproduce the diagnostic, then fix the type error.",
  eslint: "Run ESLint to reproduce the rule violation.",
  semgrep: "Run Semgrep to reproduce the rule match and confirm it applies to changed code.",
  "dependency-audit": "Re-run the dependency audit and review the affected package."
};

/**
 * Convert a deterministic analyzer signal into a finding. Used only for signals
 * the LLM did not triage, so they are not silently lost. Analyzer findings carry
 * high confidence and link back to the originating signal id.
 */
export function promoteSignal(signal: AnalyzerSignal): Finding {
  const evidence = signal.evidence.length > 0 ? signal.evidence : [`${signal.analyzer}: ${signal.ruleId}`];

  return {
    fingerprint: `fp_${createHash("sha1").update(signal.id).digest("hex").slice(0, 16)}`,
    ruleId: signal.ruleId,
    title: truncateTitle(signal.message),
    message: signal.message,
    category: ANALYZER_CATEGORY[signal.analyzer] ?? "quality",
    severity: signal.severity,
    confidenceLabel: "high",
    source: "analyzer",
    range: {
      file: signal.range.file,
      startLine: signal.range.startLine,
      endLine: signal.range.endLine,
      diffSide: signal.range.diffSide ?? "right"
    },
    evidence,
    impact: signal.message,
    suggestion: undefined,
    verification: ANALYZER_VERIFICATION[signal.analyzer] ?? "Re-run the analyzer to confirm.",
    relatedSignals: [signal.id],
    tags: ["analyzer"]
  };
}

function truncateTitle(message: string): string {
  const single = message.replace(/\s+/g, " ").trim();
  return single.length > 80 ? `${single.slice(0, 79)}...` : single;
}
