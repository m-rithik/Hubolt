import { CONTEXT_ADJACENT_TAG, type Finding, type Severity } from "../types/finding.js";

const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

const CONFIDENCE_ORDER: Record<Finding["confidenceLabel"], number> = {
  low: 0,
  medium: 1,
  high: 2
};

export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER[severity];
}

export function filterByThreshold(findings: Finding[], threshold: Severity): Finding[] {
  const minimum = SEVERITY_ORDER[threshold];
  return findings.filter((finding) => SEVERITY_ORDER[finding.severity] >= minimum);
}

export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];

  for (const finding of findings) {
    if (seen.has(finding.fingerprint)) {
      continue;
    }
    seen.add(finding.fingerprint);
    result.push(finding);
  }

  return result;
}

function isContextAdjacent(finding: Finding): boolean {
  return finding.tags.includes(CONTEXT_ADJACENT_TAG);
}

export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }
    const byConfidence = CONFIDENCE_ORDER[b.confidenceLabel] - CONFIDENCE_ORDER[a.confidenceLabel];
    if (byConfidence !== 0) {
      return byConfidence;
    }
    // Findings outside the changed lines sort below directly-changed ones.
    return Number(isContextAdjacent(a)) - Number(isContextAdjacent(b));
  });
}
