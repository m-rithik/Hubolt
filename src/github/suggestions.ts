import type { Finding } from "../types/finding.js";
import { isRangeFullyAdded, type DiffIndex } from "./line-mapping.js";

/**
 * Build the GitHub suggestion block for a finding, or null when the finding
 * is not eligible. Eligibility is deliberately strict: the finding must carry
 * a concrete replacement (fixPatch), and its whole range must consist of
 * lines this PR added, since accepting a suggestion replaces the entire
 * commented range.
 */
export function buildSuggestionBlock(finding: Finding, index: DiffIndex): string | null {
  const replacement = finding.fixPatch;
  if (!replacement || replacement.trim().length === 0) {
    return null;
  }

  // A fence inside the replacement would terminate the suggestion block early
  // and post broken markup; fixPatch is model output, so treat it as untrusted.
  if (replacement.includes("```")) {
    return null;
  }

  if (!isRangeFullyAdded(finding.range, index)) {
    return null;
  }

  const body = replacement.endsWith("\n") ? replacement.slice(0, -1) : replacement;
  return "```suggestion\n" + body + "\n```";
}
