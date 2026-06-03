import { describe, expect, test } from "vitest";
import { RepoConfigSchema } from "../../src/config/schema.js";
import type { BuiltContext } from "../../src/core/context-builder.js";
import { runReviewPipeline } from "../../src/core/pipeline.js";
import type { LLMFinding } from "../../src/types/finding.js";
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

function fakeProvider(findings: LLMFinding[]): LLMProvider {
  return {
    name: "fake",
    async review() {
      return findings;
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
});
