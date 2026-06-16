import type { Finding } from "../types/finding.js";
import { calibrateConfidence, type ConfidenceLabel } from "./calibration.js";
import { decideSuppression } from "./suppression.js";
import { EMPTY_FEEDBACK_STATS, type FindingFeedbackContext } from "./feedback-types.js";

export interface FeedbackLookup {
  /** Aggregated feedback keyed by finding fingerprint. */
  byFingerprint: Map<string, FindingFeedbackContext["byFingerprint"]>;
  /** Aggregated feedback keyed by rule id. */
  byRule: Map<string, FindingFeedbackContext["byRule"]>;
  /** Role breakdown of dismissals, keyed by fingerprint; empty when unknown. */
  fingerprintDismissals?: Map<string, FindingFeedbackContext["fingerprintDismissals"]>;
}

export interface AppliedFeedback {
  /** Findings to post inline, with calibrated confidence labels. */
  kept: Finding[];
  /** Demoted to the summary with the reason feedback history gives. */
  summaryOnly: Array<{ finding: Finding; reason: string }>;
  /** Fully suppressed; recorded for counts, never posted. */
  suppressed: Array<{ finding: Finding; reason: string }>;
  calibrationsApplied: number;
}

/**
 * Apply team feedback history to a fresh batch of findings: suppress or
 * demote what the team has repeatedly rejected, and recalibrate confidence
 * from the rule's acceptance record. Pure; the caller supplies aggregates.
 */
export function applyFeedback(findings: Finding[], lookup: FeedbackLookup): AppliedFeedback {
  const kept: Finding[] = [];
  const summaryOnly: AppliedFeedback["summaryOnly"] = [];
  const suppressed: AppliedFeedback["suppressed"] = [];
  let calibrationsApplied = 0;

  for (const finding of findings) {
    const context: FindingFeedbackContext = {
      byFingerprint: lookup.byFingerprint.get(finding.fingerprint) ?? EMPTY_FEEDBACK_STATS,
      byRule: lookup.byRule.get(finding.ruleId) ?? EMPTY_FEEDBACK_STATS,
      fingerprintDismissals: lookup.fingerprintDismissals?.get(finding.fingerprint)
    };

    const decision = decideSuppression(finding, context);
    if (decision.action === "suppress") {
      suppressed.push({ finding, reason: decision.reason });
      continue;
    }

    const calibrated = calibrateConfidence(
      finding.confidenceLabel as ConfidenceLabel,
      context.byRule
    );
    const next = calibrated.adjusted
      ? { ...finding, confidenceLabel: calibrated.label }
      : finding;
    if (calibrated.adjusted) {
      calibrationsApplied += 1;
    }

    if (decision.action === "summary-only") {
      summaryOnly.push({ finding: next, reason: decision.reason });
    } else {
      kept.push(next);
    }
  }

  return { kept, summaryOnly, suppressed, calibrationsApplied };
}
