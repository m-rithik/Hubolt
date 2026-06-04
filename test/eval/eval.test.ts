import { describe, expect, test } from "vitest";
import { DEFAULT_FIXTURE_DIR, loadFixtures, parseFixture, type Fixture } from "../../src/eval/fixtures.js";
import { matchFindings, scoreFixture } from "../../src/eval/score.js";
import { evaluateGate, runEval } from "../../src/eval/runner.js";
import type { Finding, LLMFinding } from "../../src/types/finding.js";
import type { LLMProvider } from "../../src/types/providers.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    fingerprint: "fp_x",
    ruleId: "security.injection",
    title: "t",
    message: "m",
    category: "security",
    severity: "high",
    confidenceLabel: "high",
    source: "llm",
    range: { file: "src/users.ts", startLine: 2, endLine: 2, diffSide: "right" },
    evidence: ["e"],
    impact: "i",
    verification: "v",
    relatedSignals: [],
    tags: [],
    ...overrides
  };
}

function provider(findings: LLMFinding[]): LLMProvider {
  return { name: "fake", async review() { return findings; } };
}

function llmFinding(overrides: Partial<LLMFinding> = {}): LLMFinding {
  return {
    ruleId: "security.injection",
    title: "t",
    message: "m",
    category: "security",
    severity: "high",
    confidenceLabel: "high",
    range: { file: "src/users.ts", startLine: 2, endLine: 2 },
    evidence: ["e"],
    impact: "i",
    suggestion: "",
    verification: "v",
    relatedSignals: [],
    ...overrides
  };
}

const fixture: Fixture = {
  name: "sql",
  description: "",
  category: "security",
  files: [{ path: "src/users.ts", content: "x\ny\n", changedRanges: [] }],
  expected: [{ file: "src/users.ts", startLine: 2, endLine: 2, category: "security" }],
  expectedNonFindings: []
};

describe("fixtures", () => {
  test("the shipped fixture directory parses", () => {
    const fixtures = loadFixtures(DEFAULT_FIXTURE_DIR);
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
    expect(fixtures.map((entry) => entry.name)).toContain("sql-injection");
  });

  test("rejects a malformed fixture", () => {
    expect(() => parseFixture('{"name": ""}', "bad.json")).toThrow();
  });
});

describe("scoring", () => {
  test("matches by file, range overlap, and category", () => {
    const { matched, unmatchedProduced } = matchFindings([finding()], fixture.expected);
    expect(matched).toHaveLength(1);
    expect(unmatchedProduced).toHaveLength(0);
  });

  test("counts an extra finding as a false positive and exact range as accurate", () => {
    const score = scoreFixture("sql", [finding(), finding({ range: { file: "src/users.ts", startLine: 9, endLine: 9, diffSide: "right" } })], fixture.expected);
    expect(score.truePositives).toBe(1);
    expect(score.falsePositives).toBe(1);
    expect(score.rangeMatches).toBe(1);
  });
});

describe("runEval and gate", () => {
  test("a matching model finding scores a true positive and passes the gate", async () => {
    const run = await runEval({ fixtures: [fixture], llm: provider([llmFinding()]) });
    expect(run.totals.truePositives).toBe(1);
    expect(run.totals.precision).toBe(1);
    expect(evaluateGate(run).passed).toBe(true);
  });

  test("max-false-positives gate fails when the model over-reports", async () => {
    const noisy: Fixture = { ...fixture, expected: [] };
    const run = await runEval({ fixtures: [noisy], llm: provider([llmFinding()]) });
    expect(run.totals.falsePositives).toBe(1);
    expect(evaluateGate(run, { maxFalsePositives: 0 }).passed).toBe(false);
  });

  test("missed critical expected finding fails the gate", async () => {
    const critical: Fixture = {
      ...fixture,
      expected: [{ file: "src/users.ts", startLine: 2, endLine: 2, category: "security", severity: "critical" }]
    };
    const run = await runEval({ fixtures: [critical], llm: provider([]) });
    expect(run.totals.missedCritical).toBe(1);
    expect(evaluateGate(run).passed).toBe(false);
  });
});
