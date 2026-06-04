import type { ReviewReport } from "../types/reports.js";

/** Render a review report as stable, pretty-printed JSON for automation. */
export function renderJsonReport(report: ReviewReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
