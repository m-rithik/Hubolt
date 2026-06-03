import type { ReviewSummary } from "../types/reports.js";

export function renderMarkdownReport(summary: ReviewSummary): string {
  return [
    "# Hubolt Review Report",
    "",
    `Status: ${summary.status}`,
    `Findings: ${summary.findings.length}`,
    `Events: ${summary.events.length}`
  ].join("\n");
}
