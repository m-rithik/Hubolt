import type { Finding } from "../types/finding.js";
import { severityRank } from "../core/rank.js";
import type { ExpectedFinding } from "./fixtures.js";

export interface FixtureScore {
  name: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  missedCritical: number;
  rangeMatches: number;
  rangeComparable: number;
}

export interface EvalTotals {
  fixtures: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  missedCritical: number;
  precision: number;
  recall: number;
  rangeAccuracy: number;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** Does a produced finding satisfy an expected finding? */
function isMatch(finding: Finding, expected: ExpectedFinding): boolean {
  if (finding.range.file !== expected.file) {
    return false;
  }
  if (!overlaps(finding.range.startLine, finding.range.endLine, expected.startLine, expected.endLine)) {
    return false;
  }
  if (expected.category && finding.category !== expected.category) {
    return false;
  }
  if (expected.severity && finding.severity !== expected.severity) {
    return false;
  }
  if (expected.ruleIdIncludes && !finding.ruleId.includes(expected.ruleIdIncludes)) {
    return false;
  }
  return true;
}

/**
 * Greedily match produced findings to expected findings, one-to-one. Returns the
 * matched pairs plus the unmatched on each side.
 */
export function matchFindings(
  produced: Finding[],
  expected: ExpectedFinding[]
): { matched: Array<{ finding: Finding; expected: ExpectedFinding }>; unmatchedExpected: ExpectedFinding[]; unmatchedProduced: Finding[] } {
  const usedProduced = new Set<number>();
  const matched: Array<{ finding: Finding; expected: ExpectedFinding }> = [];
  const unmatchedExpected: ExpectedFinding[] = [];

  for (const exp of expected) {
    const index = produced.findIndex((finding, i) => !usedProduced.has(i) && isMatch(finding, exp));
    if (index === -1) {
      unmatchedExpected.push(exp);
    } else {
      usedProduced.add(index);
      matched.push({ finding: produced[index], expected: exp });
    }
  }

  const unmatchedProduced = produced.filter((_, i) => !usedProduced.has(i));
  return { matched, unmatchedExpected, unmatchedProduced };
}

/** Score one fixture's produced findings against its expectations. */
export function scoreFixture(name: string, produced: Finding[], expected: ExpectedFinding[]): FixtureScore {
  const { matched, unmatchedExpected, unmatchedProduced } = matchFindings(produced, expected);

  let rangeMatches = 0;
  let rangeComparable = 0;
  for (const pair of matched) {
    rangeComparable += 1;
    if (pair.finding.range.startLine === pair.expected.startLine && pair.finding.range.endLine === pair.expected.endLine) {
      rangeMatches += 1;
    }
  }

  const missedCritical = unmatchedExpected.filter(
    (exp) => exp.severity !== undefined && severityRank(exp.severity) >= severityRank("critical")
  ).length;

  return {
    name,
    truePositives: matched.length,
    falsePositives: unmatchedProduced.length,
    falseNegatives: unmatchedExpected.length,
    missedCritical,
    rangeMatches,
    rangeComparable
  };
}

/** Aggregate per-fixture scores into precision, recall, and range accuracy. */
export function aggregate(scores: FixtureScore[]): EvalTotals {
  const sum = (pick: (score: FixtureScore) => number): number => scores.reduce((total, score) => total + pick(score), 0);

  const tp = sum((s) => s.truePositives);
  const fp = sum((s) => s.falsePositives);
  const fn = sum((s) => s.falseNegatives);
  const rangeMatches = sum((s) => s.rangeMatches);
  const rangeComparable = sum((s) => s.rangeComparable);

  return {
    fixtures: scores.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    missedCritical: sum((s) => s.missedCritical),
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    rangeAccuracy: rangeComparable === 0 ? 1 : rangeMatches / rangeComparable
  };
}
