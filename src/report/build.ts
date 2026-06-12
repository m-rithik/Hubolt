import type { RepoConfig } from "../config/schema.js";
import { PROMPT_VERSION } from "../core/prompt.js";
import { severityRank } from "../core/rank.js";
import type { ReviewResult } from "../core/pipeline.js";
import type { AnalyzerSignal, Finding, Severity } from "../types/finding.js";
import { EMPTY_SEVERITY_COUNTS, type ReviewReport, type SeverityCounts } from "../types/reports.js";
// Pure pricing data shared with the server's gateway; no runtime coupling.
import { getModelInfo } from "../server/services/model-catalog.js";

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
    config,
    ...(result.usage
      ? {
          modelUsage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            estimatedCostUsd: estimateCost(params.provider, params.model, result.usage)
          }
        }
      : {})
  };
}

/**
 * Cost from the shared model catalog when the model is listed there; zero
 * otherwise (unknown models report tokens but make no pricing claim). CLI
 * provider ids differ from catalog keys only for claude -> anthropic.
 */
function estimateCost(
  provider: string,
  model: string,
  usage: NonNullable<ReviewResult["usage"]>
): number {
  const catalogProvider = provider === "claude" ? "anthropic" : provider;
  const info = getModelInfo(catalogProvider, model);
  if (!info) return 0;
  return ((usage.inputTokens + usage.outputTokens) / 1000) * info.costPer1kTokens;
}

function countBySeverity(findings: Finding[]): SeverityCounts {
  const counts: SeverityCounts = { ...EMPTY_SEVERITY_COUNTS };
  for (const finding of findings) {
    counts[finding.severity as Severity] += 1;
  }
  return counts;
}
