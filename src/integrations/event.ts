import { redactSecrets } from "../core/redact.js";
import type { ReviewReport } from "../types/reports.js";
import type { IntegrationEvent, IntegrationFinding } from "./types.js";

/**
 * Map a durable review report onto the integration boundary event. This is the
 * one place that bridges core artifacts to adapters: it strips findings down to
 * summary-level fields and redacts the free-text it does carry, so a secret in a
 * finding title can never reach an external service. Findings are capped so a
 * notification stays a summary, not a per-finding dump.
 */

const MAX_LISTED_FINDINGS = 10;

export function buildIntegrationEvent(report: ReviewReport): IntegrationEvent {
  const listed = report.findings.slice(0, MAX_LISTED_FINDINGS).map(toIntegrationFinding);

  return {
    kind: "review.completed",
    scope: redact(report.scope),
    status: report.status,
    mode: report.mode,
    provider: report.provider,
    model: report.model,
    summary: report.summary,
    findings: listed,
    truncated: report.findings.length > listed.length,
    generatedAt: report.generatedAt
  };
}

function toIntegrationFinding(finding: ReviewReport["findings"][number]): IntegrationFinding {
  return {
    ruleId: finding.ruleId,
    title: redact(finding.title),
    severity: finding.severity,
    category: finding.category,
    file: finding.range.file,
    lineStart: finding.range.startLine,
    lineEnd: finding.range.endLine
  };
}

function redact(text: string): string {
  return redactSecrets(text).text;
}
