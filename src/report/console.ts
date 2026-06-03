import type { ReviewSummary } from "../types/reports.js";

export function renderConsoleSummary(summary: ReviewSummary): string {
  const findingCount = summary.findings.length;
  return `Hubolt review ${summary.status}: ${findingCount} finding${findingCount === 1 ? "" : "s"}.`;
}
