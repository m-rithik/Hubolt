import { describe, expect, test } from "vitest";
import { RepoConfigSchema } from "../../src/config/schema.js";
import type { BuiltContext } from "../../src/core/context-builder.js";
import { runReviewPipeline } from "../../src/core/pipeline.js";
import { CONTEXT_ADJACENT_TAG, type LLMFinding } from "../../src/types/finding.js";
import type { LLMProvider } from "../../src/types/providers.js";

function llmFinding(overrides: Partial<LLMFinding> = {}): LLMFinding {
  return {
    ruleId: "performance.unbounded-query",
    title: "title",
    message: "message",
    category: "performance",
    severity: "high",
    confidenceLabel: "high",
    range: { file: "src/a.ts", startLine: 10, endLine: 12 },
    evidence: ["evidence"],
    impact: "impact",
    suggestion: "",
    verification: "verification",
    ...overrides
  };
}

function fakeProvider(findings: unknown[]): LLMProvider {
  return {
    name: "fake",
    async review() {
      return findings as LLMFinding[];
    }
  };
}

const context: BuiltContext = {
  scope: "working tree",
  files: [{ path: "src/a.ts", status: "modified", changedRanges: [], content: "x" }],
  reviewable: [{ path: "src/a.ts", status: "modified", changedRanges: [], content: "x" }]
};

describe("runReviewPipeline", () => {
  test("filters out-of-scope and below-threshold findings, dedupes, and ranks", async () => {
    const config = RepoConfigSchema.parse({ severityThreshold: "medium" });
    const llm = fakeProvider([
      llmFinding(),
      llmFinding(),
      llmFinding({ severity: "info", ruleId: "style.naming", range: { file: "src/a.ts", startLine: 3, endLine: 3 } }),
      llmFinding({ range: { file: "src/other.ts", startLine: 1, endLine: 1 } })
    ]);

    const result = await runReviewPipeline({ context, config, llm });

    expect(result.rawCount).toBe(4);
    expect(result.droppedOutOfScope).toBe(1);
    expect(result.belowThreshold).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].source).toBe("llm");
    expect(result.findings[0].fingerprint).toMatch(/^fp_/);
  });

  test("drops findings with invalid ranges or empty evidence", async () => {
    const config = RepoConfigSchema.parse({ severityThreshold: "low" });
    const llm = fakeProvider([
      llmFinding({ range: { file: "src/a.ts", startLine: 12, endLine: 10 } }), // endLine < startLine
      llmFinding({ ruleId: "x.zero", range: { file: "src/a.ts", startLine: 0, endLine: 0 } }), // non-positive
      llmFinding({ ruleId: "x.empty", evidence: [] }), // missing evidence
      llmFinding({ ruleId: "x.ok" }) // valid
    ]);

    const result = await runReviewPipeline({ context, config, llm });

    expect(result.rawCount).toBe(4);
    expect(result.droppedInvalid).toBe(3);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].ruleId).toBe("x.ok");
  });

  test("drops malformed LLM findings without throwing", async () => {
    const config = RepoConfigSchema.parse({ severityThreshold: "low" });
    const missingSuggestion = { ...llmFinding({ ruleId: "x.missing-suggestion" }) };
    const missingRange = { ...llmFinding({ ruleId: "x.missing-range" }) };
    delete (missingSuggestion as Partial<LLMFinding>).suggestion;
    delete (missingRange as Partial<LLMFinding>).range;

    const result = await runReviewPipeline({
      context,
      config,
      llm: fakeProvider([missingSuggestion, missingRange, llmFinding({ ruleId: "x.ok" })])
    });

    expect(result.rawCount).toBe(3);
    expect(result.droppedInvalid).toBe(2);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].ruleId).toBe("x.ok");
  });

  test("tags findings outside the changed line ranges as context-adjacent", async () => {
    const scopedContext: BuiltContext = {
      scope: "working tree",
      files: [{ path: "src/a.ts", status: "modified", changedRanges: [{ startLine: 10, endLine: 12 }], content: "x" }],
      reviewable: [{ path: "src/a.ts", status: "modified", changedRanges: [{ startLine: 10, endLine: 12 }], content: "x" }]
    };
    const config = RepoConfigSchema.parse({ severityThreshold: "low" });
    const llm = fakeProvider([
      llmFinding({ ruleId: "x.inside", range: { file: "src/a.ts", startLine: 11, endLine: 11 } }),
      llmFinding({ ruleId: "x.outside", range: { file: "src/a.ts", startLine: 40, endLine: 41 } })
    ]);

    const result = await runReviewPipeline({ context: scopedContext, config, llm });

    const inside = result.findings.find((finding) => finding.ruleId === "x.inside");
    const outside = result.findings.find((finding) => finding.ruleId === "x.outside");
    expect(inside?.tags).not.toContain(CONTEXT_ADJACENT_TAG);
    expect(outside?.tags).toContain(CONTEXT_ADJACENT_TAG);
    // Directly-changed findings rank above context-adjacent ones at equal severity.
    expect(result.findings[0].ruleId).toBe("x.inside");
  });
});
