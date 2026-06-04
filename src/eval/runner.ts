import { RepoConfigSchema } from "../config/schema.js";
import type { BuiltContext, ReviewFile } from "../core/context-builder.js";
import { runReviewPipeline } from "../core/pipeline.js";
import type { LLMProvider } from "../types/providers.js";
import type { Fixture } from "./fixtures.js";
import { aggregate, scoreFixture, type EvalTotals, type FixtureScore } from "./score.js";

export interface FixtureResult {
  score: FixtureScore;
  /** Findings the model produced that failed schema validation (eval gate). */
  schemaInvalid: number;
}

export interface EvalRun {
  results: FixtureResult[];
  totals: EvalTotals;
}

/** Build a review context directly from fixture files (all treated as changed). */
export function fixtureContext(fixture: Fixture): BuiltContext {
  const files: ReviewFile[] = fixture.files.map((file) => ({
    path: file.path,
    status: "modified",
    changedRanges: file.changedRanges,
    content: file.content,
    regions: []
  }));

  return { scope: `eval:${fixture.name}`, files, reviewable: files };
}

/**
 * Run the review pipeline over each fixture and score the output. The LLM is
 * injected so this is testable with a fake and reusable by the CLI with the
 * configured provider. Analyzers are not run here, so eval measures LLM review
 * quality in isolation.
 */
export async function runEval(params: { fixtures: Fixture[]; llm: LLMProvider }): Promise<EvalRun> {
  const results: FixtureResult[] = [];

  for (const fixture of params.fixtures) {
    // Default to the lowest threshold so eval sees every finding; a fixture may
    // still override config explicitly.
    const config = RepoConfigSchema.parse({ severityThreshold: "info", ...(fixture.config ?? {}) });
    const context = fixtureContext(fixture);

    const result = await runReviewPipeline({ context, config, llm: params.llm });
    results.push({
      score: scoreFixture(fixture.name, result.findings, fixture.expected),
      schemaInvalid: result.droppedInvalid
    });
  }

  return { results, totals: aggregate(results.map((entry) => entry.score)) };
}

export interface GateOptions {
  maxFalsePositives?: number;
  minRangeAccuracy?: number;
}

export interface GateResult {
  passed: boolean;
  reasons: string[];
}

/**
 * Decide whether an eval run passes. Always fails on a missed critical or
 * schema-invalid output; false-positive and range-accuracy gates apply only when
 * a threshold is provided.
 */
export function evaluateGate(run: EvalRun, options: GateOptions = {}): GateResult {
  const reasons: string[] = [];

  if (run.totals.missedCritical > 0) {
    reasons.push(`${run.totals.missedCritical} critical expected finding(s) missed`);
  }

  const schemaInvalid = run.results.reduce((total, entry) => total + entry.schemaInvalid, 0);
  if (schemaInvalid > 0) {
    reasons.push(`${schemaInvalid} model finding(s) failed schema validation`);
  }

  if (options.maxFalsePositives !== undefined && run.totals.falsePositives > options.maxFalsePositives) {
    reasons.push(`${run.totals.falsePositives} false positive(s) exceed limit of ${options.maxFalsePositives}`);
  }

  if (options.minRangeAccuracy !== undefined && run.totals.rangeAccuracy < options.minRangeAccuracy) {
    reasons.push(`range accuracy ${run.totals.rangeAccuracy.toFixed(2)} below ${options.minRangeAccuracy}`);
  }

  return { passed: reasons.length === 0, reasons };
}
