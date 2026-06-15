import type { FeedbackStats } from "./feedback-types.js";

export type ConfidenceLabel = "low" | "medium" | "high";

const ORDER: ConfidenceLabel[] = ["low", "medium", "high"];
const MIN_SAMPLE = 5;

/**
 * Calibrate a finding's confidence label from the rule's historical
 * acceptance rate. Requires a minimum sample before moving anything, shifts
 * by at most one step, and ignores "discussed" (engagement, not a verdict).
 */
export function calibrateConfidence(
  label: ConfidenceLabel,
  ruleStats: FeedbackStats
): { label: ConfidenceLabel; adjusted: boolean } {
  const total = ruleStats.accepted + ruleStats.dismissed;
  if (total < MIN_SAMPLE) {
    return { label, adjusted: false };
  }

  const acceptanceRate = ruleStats.accepted / total;
  const index = ORDER.indexOf(label);

  if (acceptanceRate >= 0.8 && index < ORDER.length - 1) {
    return { label: ORDER[index + 1], adjusted: true };
  }
  if (acceptanceRate <= 0.2 && index > 0) {
    return { label: ORDER[index - 1], adjusted: true };
  }

  return { label, adjusted: false };
}
