import type { ReviewSummary } from "../types/reports.js";

export function renderJsonReport(summary: ReviewSummary): string {
  return JSON.stringify(summary, null, 2);
}
