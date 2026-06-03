import type { Finding } from "./finding.js";
import type { ReviewEvent } from "./events.js";

export interface ReviewSummary {
  status: "ok" | "blocked" | "failed";
  findings: Finding[];
  events: ReviewEvent[];
}
