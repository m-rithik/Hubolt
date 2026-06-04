import { describe, expect, test } from "vitest";
import { RepoConfigSchema } from "../../src/config/schema.js";
import type { ReviewResult } from "../../src/core/pipeline.js";
import { buildReport, renderJsonReport, renderMarkdownReport } from "../../src/report/index.js";
import { parseReport } from "../../src/types/reports.js";
import type { AnalyzerSignal, Finding } from "../../src/types/finding.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    fingerprint: "fp_1",
    ruleId: "security.injection",
    title: "SQL injection",
    message: "concatenated query",
    category: "security",
    severity: "high",
    confidenceLabel: "high",
    source: "llm",
    range: { file: "src/users.ts", startLine: 2, endLine: 2, diffSide: "right" },
    evidence: ["line 2"],
    impact: "data exposure",
    verification: "use parameters",
    relatedSignals: [],
    tags: [],
    ...overrides
  };
}

const signal: AnalyzerSignal = {
  id: "secret-scan:secret.x:src/a.ts:1",
  analyzer: "secret-scan",
  ruleId: "secret.hardcoded-credential",
  range: { file: "src/a.ts", startLine: 1, endLine: 1, diffSide: "right" },
  severity: "high",
  message: "secret",
  evidence: ["src/a.ts:1"]
};

function result(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    findings: [finding()],
    rawCount: 1,
    droppedInvalid: 0,
    droppedOutOfScope: 0,
    belowThreshold: 0,
    droppedByMode: 0,
    analyzerSignals: 1,
    promotedFromAnalyzers: 0,
    ...overrides
  };
}

const params = {
  scope: "staged changes",
  config: RepoConfigSchema.parse({}),
  provider: "openai",
  model: "gpt-4.1-mini",
  result: result(),
  analyzerSignals: [signal]
};

describe("buildReport", () => {
  test("summarizes severities and marks blocked when failOnSeverity is reached", () => {
    const report = buildReport({ ...params, config: RepoConfigSchema.parse({ failOnSeverity: "high" }) });
    expect(report.schemaVersion).toBe(1);
    expect(report.summary.total).toBe(1);
    expect(report.summary.bySeverity.high).toBe(1);
    expect(report.status).toBe("blocked");
    expect(report.analyzerSignals).toHaveLength(1);
  });

  test("status is ok when no finding reaches failOnSeverity", () => {
    const report = buildReport({ ...params, config: RepoConfigSchema.parse({ failOnSeverity: "critical" }) });
    expect(report.status).toBe("ok");
  });
});

describe("renderers", () => {
  test("JSON report round-trips through parseReport", () => {
    const report = buildReport(params);
    const json = renderJsonReport(report);
    expect(() => parseReport(json, "test")).not.toThrow();
    expect(parseReport(json, "test").summary.total).toBe(1);
  });

  test("Markdown report includes the finding and analyzer signal", () => {
    const md = renderMarkdownReport(buildReport(params));
    expect(md).toContain("# Hubolt Review");
    expect(md).toContain("SQL injection");
    expect(md).toContain("src/users.ts:2-2");
    expect(md).toContain("## Analyzer signals");
  });

  test("parseReport rejects malformed JSON", () => {
    expect(() => parseReport("{not json", "bad")).toThrow();
  });
});
