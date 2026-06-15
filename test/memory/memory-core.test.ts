import { describe, expect, test } from "vitest";
import { decideSuppression } from "../../src/memory/suppression.js";
import { calibrateConfidence } from "../../src/memory/calibration.js";
import { applyFeedback } from "../../src/memory/apply.js";
import { buildRuleCards } from "../../src/memory/cards.js";
import { retrieveCards } from "../../src/memory/retrieval.js";
import { EMPTY_FEEDBACK_STATS } from "../../src/memory/feedback-types.js";
import type { Finding } from "../../src/types/finding.js";

const none = EMPTY_FEEDBACK_STATS;
const stats = (accepted: number, dismissed: number, discussed = 0) => ({ accepted, dismissed, discussed });

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    fingerprint: "fp-1",
    ruleId: "rule-1",
    title: "t",
    message: "m",
    category: "quality",
    severity: "medium",
    confidenceLabel: "medium",
    source: "llm",
    range: { file: "a.ts", startLine: 1, endLine: 1, diffSide: "right" },
    evidence: ["e"],
    impact: "i",
    verification: "v",
    relatedSignals: [],
    tags: [],
    ...overrides
  } as Finding;
}

describe("decideSuppression", () => {
  test("never auto-suppresses critical or high security findings", () => {
    const heavy = { byFingerprint: stats(0, 10), byRule: stats(0, 50) };
    expect(decideSuppression({ severity: "critical", category: "quality" }, heavy).action).toBe("keep");
    expect(decideSuppression({ severity: "high", category: "security" }, heavy).action).toBe("keep");
  });

  test("escalates with repeated fingerprint dismissals", () => {
    const base = { byRule: none };
    expect(decideSuppression(finding(), { ...base, byFingerprint: stats(0, 1) }).action).toBe("keep");
    expect(decideSuppression(finding(), { ...base, byFingerprint: stats(0, 2) }).action).toBe("summary-only");
    expect(decideSuppression(finding(), { ...base, byFingerprint: stats(0, 3) }).action).toBe("suppress");
  });

  test("an acceptance vetoes fingerprint-based suppression", () => {
    const context = { byFingerprint: stats(1, 5), byRule: none };
    expect(decideSuppression(finding(), context).action).toBe("keep");
  });

  test("a heavily dismissed rule class demotes to summary, never suppresses", () => {
    const context = { byFingerprint: none, byRule: stats(0, 6) };
    expect(decideSuppression(finding(), context)).toEqual({
      action: "summary-only",
      reason: "rule dismissed 6 times across reviews"
    });
  });
});

describe("calibrateConfidence", () => {
  test("needs a minimum sample before adjusting", () => {
    expect(calibrateConfidence("medium", stats(4, 0))).toEqual({ label: "medium", adjusted: false });
  });

  test("bumps up on high acceptance and down on low, one step, clamped", () => {
    expect(calibrateConfidence("medium", stats(8, 1))).toEqual({ label: "high", adjusted: true });
    expect(calibrateConfidence("high", stats(8, 1))).toEqual({ label: "high", adjusted: false });
    expect(calibrateConfidence("medium", stats(1, 9))).toEqual({ label: "low", adjusted: true });
    expect(calibrateConfidence("low", stats(1, 9))).toEqual({ label: "low", adjusted: false });
  });
});

describe("applyFeedback", () => {
  test("partitions findings and counts calibrations", () => {
    const keep = finding({ fingerprint: "fp-keep", ruleId: "rule-good" });
    const demote = finding({ fingerprint: "fp-demote" });
    const drop = finding({ fingerprint: "fp-drop" });

    const result = applyFeedback([keep, demote, drop], {
      byFingerprint: new Map([
        ["fp-demote", stats(0, 2)],
        ["fp-drop", stats(0, 4)]
      ]),
      byRule: new Map([["rule-good", stats(9, 1)]])
    });

    expect(result.kept.map((f) => f.fingerprint)).toEqual(["fp-keep"]);
    expect(result.kept[0].confidenceLabel).toBe("high");
    expect(result.calibrationsApplied).toBe(1);
    expect(result.summaryOnly.map((entry) => entry.finding.fingerprint)).toEqual(["fp-demote"]);
    expect(result.suppressed.map((entry) => entry.finding.fingerprint)).toEqual(["fp-drop"]);
  });
});

describe("buildRuleCards", () => {
  test("requires enough events and states the team's stance", () => {
    const cards = buildRuleCards([
      { ruleId: "noisy", repoId: "", severitySample: "low", stats: stats(0, 5) },
      { ruleId: "valued", repoId: "repo_1", severitySample: "high", stats: stats(4, 1) },
      { ruleId: "thin", repoId: "", severitySample: "low", stats: stats(1, 0) }
    ]);

    expect(cards.map((card) => card.ruleId).sort()).toEqual(["noisy", "valued"]);
    const noisy = cards.find((card) => card.ruleId === "noisy")!;
    expect(noisy.body).toContain("almost always dismisses");
    expect(noisy.tokensEstimate).toBeGreaterThan(0);
    const valued = cards.find((card) => card.ruleId === "valued")!;
    expect(valued.body).toContain("report it confidently");
    expect(valued.repoId).toBe("repo_1");
  });
});

describe("retrieveCards", () => {
  const card = (overrides: Record<string, unknown>) => ({
    kind: "rule" as const,
    repoId: "",
    ruleId: "r1",
    title: "t",
    body: "b",
    tokensEstimate: 100,
    sourceCount: 5,
    pinned: false,
    ...overrides
  });

  test("filters foreign repos and unmatched rules, prioritizes pinned style", () => {
    const cards = [
      card({ kind: "style", ruleId: "conventions", pinned: true, title: "style" }),
      card({ ruleId: "r1", title: "match" }),
      card({ ruleId: "r2", title: "no-match" }),
      card({ repoId: "other-repo", ruleId: "r1", title: "foreign" })
    ];

    const retrieved = retrieveCards(cards, { repoId: "my-repo", ruleIds: ["r1"], budgetTokens: 1000 });
    expect(retrieved.map((entry) => entry.card.title)).toEqual(["style", "match"]);
    expect(retrieved[0].reason).toContain("pinned");
    expect(retrieved[1].reason).toContain("matches a rule");
  });

  test("does not retrieve rule cards when no review rules are supplied", () => {
    const cards = [
      card({ kind: "style", ruleId: "conventions", pinned: true, title: "style" }),
      card({ ruleId: "r1", title: "rule" })
    ];

    const retrieved = retrieveCards(cards, { repoId: "my-repo", ruleIds: [], budgetTokens: 1000 });
    expect(retrieved.map((entry) => entry.card.title)).toEqual(["style"]);
  });

  test("skips cards that do not fit the remaining budget", () => {
    const cards = [
      card({ ruleId: "r1", tokensEstimate: 900, sourceCount: 20, title: "big" }),
      card({ ruleId: "r1", tokensEstimate: 200, sourceCount: 1, title: "small" })
    ];

    const retrieved = retrieveCards(cards, { ruleIds: ["r1"], budgetTokens: 1000 });
    expect(retrieved.map((entry) => entry.card.title)).toEqual(["big"]);
  });
});
