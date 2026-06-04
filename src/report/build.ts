import type { RepoConfig } from "../config/schema.js";
import { PROMPT_VERSION } from "../core/prompt.js";
import { severityRank } from "../core/rank.js";
import type { ReviewResult } from "../core/pipeline.js";
import type { AnalyzerSignal, Finding, Severity } from "../types/finding.js";
import { EMPTY_SEVERITY_COUNTS, type ReviewReport, type SeverityCounts } from "../types/reports.js";

export const HUBOLT_VERSION = "0.1.0";

export interface BuildReportParams {
  scope: string;
  config: RepoConfig;
  provider: string;
  model: string;
  result: ReviewResult;
  analyzerSignals: AnalyzerSignal[];
}

/** Assemble the durable review report from a finished pipeline run. */
export function buildReport(params: BuildReportParams): ReviewReport {
  const { result, config } = params;
  const bySeverity = countBySeverity(result.findings);
  const gate = severityRank(config.failOnSeverity);
  const blocked = result.findings.some((finding) => severityRank(finding.severity) >= gate);

  return {
    schemaVersion: 1,
    tool: { name: "hubolt", version: HUBOLT_VERSION, promptVersion: PROMPT_VERSION },
    generatedAt: new Date().toISOString(),
    scope: params.scope,
    mode: config.mode,
    provider: params.provider,
    model: params.model,
    status: blocked ? "blocked" : "ok",
    summary: { total: result.findings.length, bySeverity },
    counts: {
      rawCount: result.rawCount,
      droppedInvalid: result.droppedInvalid,
      droppedOutOfScope: result.droppedOutOfScope,
      belowThreshold: result.belowThreshold,
      droppedByMode: result.droppedByMode,
      analyzerSignals: result.analyzerSignals,
      promotedFromAnalyzers: result.promotedFromAnalyzers
    },
    findings: result.findings,
    analyzerSignals: params.analyzerSignals,
    config
  };
}

function countBySeverity(findings: Finding[]): SeverityCounts {
  const counts: SeverityCounts = { ...EMPTY_SEVERITY_COUNTS };
  for (const finding of findings) {
    counts[finding.severity as Severity] += 1;
  }
  return counts;
}
