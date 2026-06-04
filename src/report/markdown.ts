import type { Finding, Severity } from "../types/finding.js";
import type { ReviewReport } from "../types/reports.js";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

/** Render a review report as a human-readable Markdown document. */
export function renderMarkdownReport(report: ReviewReport): string {
  const lines: string[] = [];
  const title = report.mode === "security" ? "Hubolt Security Review" : "Hubolt Review";

  lines.push(`# ${title}`, "");
  lines.push(`- Status: ${report.status}`);
  lines.push(`- Scope: ${report.scope}`);
  lines.push(`- Mode: ${report.mode}`);
  lines.push(`- Provider: ${report.provider} (${report.model})`);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Hubolt ${report.tool.version}, prompt v${report.tool.promptVersion}`);
  lines.push("");

  lines.push("## Summary", "");
  lines.push(`Total findings: ${report.summary.total}`, "");
  lines.push("| Severity | Count |", "| --- | --- |");
  for (const severity of SEVERITY_ORDER) {
    lines.push(`| ${severity} | ${report.summary.bySeverity[severity]} |`);
  }
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("No findings at or above the configured severity threshold.", "");
  } else {
    lines.push("## Findings", "");
    const ordered = [...report.findings].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    );
    ordered.forEach((finding, index) => lines.push(...renderFinding(finding, index + 1)));
  }

  if (report.analyzerSignals.length > 0) {
    lines.push("## Analyzer signals", "");
    lines.push("| Analyzer | Rule | Location | Severity |", "| --- | --- | --- | --- |");
    for (const signal of report.analyzerSignals) {
      const location = `${signal.range.file}:${signal.range.startLine}`;
      lines.push(`| ${signal.analyzer} | ${signal.ruleId} | ${location} | ${signal.severity} |`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function renderFinding(finding: Finding, index: number): string[] {
  const location = `${finding.range.file}:${finding.range.startLine}-${finding.range.endLine}`;
  const lines = [
    `### ${index}. [${finding.severity}] ${finding.title}`,
    "",
    `- Location: ${location}`,
    `- Category: ${finding.category}`,
    `- Rule: ${finding.ruleId} (${finding.source})`,
    `- Impact: ${finding.impact}`
  ];
  if (finding.suggestion) {
    lines.push(`- Suggestion: ${finding.suggestion}`);
  }
  lines.push(`- Verification: ${finding.verification}`);
  if (finding.evidence.length > 0) {
    lines.push("", "Evidence:");
    for (const item of finding.evidence) {
      lines.push(`- ${item}`);
    }
  }
  lines.push("");
  return lines;
}
