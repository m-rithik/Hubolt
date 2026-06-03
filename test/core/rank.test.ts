import { describe, expect, test } from "vitest";
import type { Finding, Severity } from "../../src/types/finding.js";
import { dedupeFindings, filterByThreshold, rankFindings } from "../../src/core/rank.js";

function finding(overrides: Partial<Finding> & { fingerprint: string; severity: Severity }): Finding {
  return {
    ruleId: "rule",
    title: "t",
    message: "m",
    category: "quality",
    confidenceLabel: "medium",
    source: "llm",
    range: { file: "a.ts", startLine: 1, endLine: 1, diffSide: "right" },
    evidence: ["e"],
    impact: "i",
    verification: "v",
    relatedSignals: [],
    tags: [],
    ...overrides
  };
}

describe("rank", () => {
  test("filterByThreshold drops findings below the threshold", () => {
    const findings = [
      finding({ fingerprint: "a", severity: "low" }),
      finding({ fingerprint: "b", severity: "high" })
    ];

    expect(filterByThreshold(findings, "medium").map((f) => f.fingerprint)).toEqual(["b"]);
  });

  test("dedupeFindings removes repeated fingerprints, keeping first", () => {
    const findings = [
      finding({ fingerprint: "dup", severity: "high", title: "first" }),
      finding({ fingerprint: "dup", severity: "high", title: "second" })
    ];

    const result = dedupeFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("first");
  });

  test("rankFindings orders by severity then confidence", () => {
    const findings = [
      finding({ fingerprint: "a", severity: "medium", confidenceLabel: "high" }),
      finding({ fingerprint: "b", severity: "critical", confidenceLabel: "low" }),
      finding({ fingerprint: "c", severity: "medium", confidenceLabel: "low" })
    ];

    expect(rankFindings(findings).map((f) => f.fingerprint)).toEqual(["b", "a", "c"]);
  });
});
