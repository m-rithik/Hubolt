import { describe, expect, test } from "vitest";
import { buildInlineCommentBody, buildSummaryBody } from "../../src/github/comments.js";

function finding(over: Record<string, unknown> = {}): any {
  return {
    fingerprint: "fp1",
    ruleId: "r",
    title: "Raw input assigned",
    message: "Input is stored without validation.",
    category: "security",
    severity: "high",
    confidenceLabel: "high",
    source: "llm",
    range: { file: "src/a.ts", startLine: 2, endLine: 2, diffSide: "right" },
    evidence: ["const x = input;"],
    impact: "Unvalidated input can reach sinks.",
    verification: "Trace the variable to its uses.",
    relatedSignals: [],
    tags: [],
    ...over
  };
}

function report(findings: any[]): any {
  const bySeverity = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of findings) bySeverity[f.severity as keyof typeof bySeverity] += 1;
  return { findings, summary: { total: findings.length, bySeverity } };
}

describe("comment formatting", () => {
  test("inline comment bolds the labels and badges the severity", () => {
    const body = buildInlineCommentBody(finding(), null);
    expect(body).toContain("**Raw input assigned**");
    expect(body).toContain("`high`");
    expect(body).toContain("**Impact:**");
    expect(body).toContain("**Verify:**");
  });

  test("summary uses a table with bold counts and code-span cells", () => {
    const body = buildSummaryBody(report([finding()]), [], "abc123");
    expect(body).toContain("## Hubolt review");
    expect(body).toContain("**1 finding(s)**");
    expect(body).toContain("**high** 1");
    expect(body).toContain("| Severity | Location | Finding |");
    expect(body).toContain("| `high` | `src/a.ts:2` | **Raw input assigned** |");
    expect(body).toContain("Reviewed at head `abc123`");
  });

  test("headline is a severity-colored GitHub alert", () => {
    // high -> red CAUTION
    expect(buildSummaryBody(report([finding()]), [], "h")).toContain("> [!CAUTION]");
    // medium -> amber WARNING
    expect(buildSummaryBody(report([finding({ severity: "medium" })]), [], "h")).toContain("> [!WARNING]");
    // nothing found -> green TIP
    expect(buildSummaryBody(report([]), [], "h")).toContain("> [!TIP]");
  });

  test("not-shown-inline findings render as a table with reasons", () => {
    const body = buildSummaryBody(report([]), [{ finding: finding({ title: "Demoted" }), reason: "merge conflict" }], "abc123");
    expect(body).toContain("### Not shown inline (1)");
    expect(body).toContain("| Location | Finding | Reason |");
    expect(body).toContain("merge conflict");
  });
});
