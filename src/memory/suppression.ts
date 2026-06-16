import type { Finding } from "../types/finding.js";
import type { FindingFeedbackContext } from "./feedback-types.js";

export type SuppressionDecision =
  | { action: "keep" }
  | { action: "summary-only"; reason: string }
  | { action: "suppress"; reason: string };

/**
 * Decide what repeated feedback means for a finding. Deliberately
 * conservative, per the plan:
 * - critical findings and high+ security findings are never auto-suppressed
 * - an exact fingerprint the team dismissed before goes to summary at two
 *   dismissals and is suppressed at three, unless someone also accepted it
 * - user role, when known: a wall of dismissals with no maintainer among
 *   them is demoted, not fully silenced (outside contributors should not be
 *   able to suppress a class on their own)
 * - a rule class with heavy dismissal and no acceptance demotes new
 *   instances to summary-only (never full suppression: same rule, new code)
 */
export function decideSuppression(
  finding: Pick<Finding, "severity" | "category">,
  feedback: FindingFeedbackContext
): SuppressionDecision {
  if (finding.severity === "critical") {
    return { action: "keep" };
  }
  if (finding.category === "security" && finding.severity === "high") {
    return { action: "keep" };
  }

  const fp = feedback.byFingerprint;
  if (fp.accepted === 0 && fp.dismissed >= 3) {
    const roles = feedback.fingerprintDismissals;
    if (roles && roles.withKnownRole > 0 && roles.byMaintainer === 0) {
      return {
        action: "summary-only",
        reason: `dismissed ${fp.dismissed} times, none by a maintainer`
      };
    }
    return {
      action: "suppress",
      reason: `dismissed ${fp.dismissed} times with no acceptance`
    };
  }
  if (fp.accepted === 0 && fp.dismissed >= 2) {
    return {
      action: "summary-only",
      reason: `dismissed ${fp.dismissed} times`
    };
  }

  const rule = feedback.byRule;
  const ruleTotal = rule.accepted + rule.dismissed;
  if (ruleTotal >= 5 && rule.accepted === 0) {
    return {
      action: "summary-only",
      reason: `rule dismissed ${rule.dismissed} times across reviews`
    };
  }

  return { action: "keep" };
}
