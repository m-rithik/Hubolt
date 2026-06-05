import type { Command } from "commander";
import { resolveSettings } from "../../config/resolve.js";
import { DEFAULT_FIXTURE_DIR, loadFixtures, type Fixture } from "../../eval/fixtures.js";
import { evaluateGate, runEval, type EvalRun } from "../../eval/runner.js";
import { PROMPT_VERSION } from "../../core/prompt.js";
import { getLLMProvider } from "../../providers/llm/index.js";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";

interface EvalOptions {
  fixture?: string;
  dir?: string;
  provider?: string;
  model?: string;
  config?: string;
  maxFalsePositives?: string;
  minRangeAccuracy?: string;
}

export function registerEvalCommand(program: Command): void {
  program
    .command("eval")
    .description("Run golden review fixtures and score precision, recall, and range accuracy.")
    .option("--fixture <name>", "run a single fixture by name")
    .option("--dir <path>", `fixture directory (default ${DEFAULT_FIXTURE_DIR})`)
    .option("--provider <name>", "override the LLM provider for this run (openai, claude, google)")
    .option("--model <model>", "override the LLM model for this run")
    .option("--max-false-positives <n>", "fail when total false positives exceed this number")
    .option("--min-range-accuracy <ratio>", "fail when range accuracy is below this ratio (0-1)")
    .option("-c, --config <path>", "path to a Hubolt config file")
    .action((options: EvalOptions) => {
      return runSafelyAsync(() => runEvalCommand(options));
    });
}

async function runEvalCommand(options: EvalOptions): Promise<void> {
  const settings = resolveSettings({ configPath: options.config });
  const providerName = options.provider ?? settings.llmProvider;
  const modelName = options.model ?? settings.llmModel;

  const dir = options.dir ?? DEFAULT_FIXTURE_DIR;
  let fixtures = loadFixtures(dir);
  if (options.fixture) {
    fixtures = fixtures.filter((fixture) => fixture.name === options.fixture);
    if (fixtures.length === 0) {
      throw new Error(`No fixture named "${options.fixture}" in ${dir}.`);
    }
  }

  console.log(
    ui.section("Hubolt Eval", [
      ["Fixtures", String(fixtures.length)],
      ["Provider", `${providerName} (${modelName})`],
      ["Prompt version", PROMPT_VERSION],
      ["Dir", dir]
    ])
  );
  console.log("");

  const llm = getLLMProvider(providerName, { model: modelName });
  const run = await runEval({ fixtures, llm });

  printReport(run, fixtures);

  const gate = evaluateGate(run, {
    maxFalsePositives: parseIntOption(options.maxFalsePositives, "--max-false-positives"),
    minRangeAccuracy: parseFloatOption(options.minRangeAccuracy, "--min-range-accuracy")
  });

  console.log("");
  if (gate.passed) {
    console.log(ui.success("Eval gate passed."));
  } else {
    process.exitCode = 1;
    console.log(ui.error("Eval gate failed:"));
    for (const reason of gate.reasons) {
      console.log(ui.error(`- ${reason}`));
    }
  }
}

function printReport(run: EvalRun, fixtures: Fixture[]): void {
  const rows = run.results.map((entry, index) => {
    const score = entry.score;
    return [
      fixtures[index].name,
      String(score.truePositives),
      String(score.falsePositives),
      String(score.falseNegatives),
      score.rangeComparable === 0 ? "-" : (score.rangeMatches / score.rangeComparable).toFixed(2)
    ];
  });

  console.log(ui.grid(["Fixture", "TP", "FP", "FN", "RangeAcc"], rows));
  console.log("");

  const totals = run.totals;
  console.log(
    ui.section("Totals", [
      ["Precision", totals.precision.toFixed(2)],
      ["Recall", totals.recall.toFixed(2)],
      ["False positives", String(totals.falsePositives)],
      ["Missed critical", String(totals.missedCritical)],
      ["Range accuracy", totals.rangeAccuracy.toFixed(2)]
    ])
  );
}

function parseIntOption(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${flag}: ${value}. Expected a non-negative integer.`);
  }
  return parsed;
}

function parseFloatOption(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid ${flag}: ${value}. Expected a ratio between 0 and 1.`);
  }
  return parsed;
}
