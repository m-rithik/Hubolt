import type { Command } from "commander";
import { resolveSettings } from "../../config/resolve.js";
import { buildAnalyzerContext, runAnalyzers, selectAnalyzers } from "../../core/analyze.js";
import { buildContext } from "../../core/context-builder.js";
import { getGitRoot, isGitRepository } from "../../core/git.js";
import type { AnalyzerSignal, Severity } from "../../types/finding.js";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";

interface AnalyzeOptions {
  staged?: boolean;
  base?: string;
  head?: string;
  config?: string;
}

export function registerAnalyzeCommand(program: Command): void {
  program
    .command("analyze")
    .description("Run static analyzers over local changes without calling an LLM.")
    .option("--staged", "analyze staged changes instead of the working tree")
    .option("--base <ref>", "base ref for a commit-range analysis (requires --head)")
    .option("--head <ref>", "head ref for a commit-range analysis (requires --base)")
    .option("-c, --config <path>", "path to a Hubolt config file")
    .action((options: AnalyzeOptions) => {
      return runSafelyAsync(() => runAnalyze(options));
    });
}

async function runAnalyze(options: AnalyzeOptions): Promise<void> {
  if (Boolean(options.base) !== Boolean(options.head)) {
    throw new Error("Provide both --base and --head to analyze a commit range.");
  }

  if (!isGitRepository()) {
    throw new Error("Not a git repository. Run Hubolt inside a git working tree.");
  }

  const repoRoot = getGitRoot();
  const settings = resolveSettings({ cwd: options.config ? process.cwd() : repoRoot, configPath: options.config });
  const context = await buildContext({
    cwd: repoRoot,
    staged: options.staged,
    base: options.base,
    head: options.head,
    config: settings.repo
  });

  const { names, skipped: notSelected } = selectAnalyzers(settings.repo);
  const analyzerContext = buildAnalyzerContext(context, { repoRoot, config: settings.repo });
  const { signals, ran, skipped } = await runAnalyzers(analyzerContext, names);

  console.log(
    ui.section("Hubolt Analyze", [
      ["Scope", context.scope],
      ["Config", settings.configPath ?? "built-in defaults"],
      ["Files", String(context.reviewable.length)],
      ["Analyzers", ran.length > 0 ? ran.join(", ") : "none"]
    ])
  );
  console.log("");

  if (context.reviewable.length === 0) {
    console.log(ui.muted("No reviewable files in scope."));
    return;
  }

  printSignals(signals);

  const allSkipped = [...notSelected, ...skipped];
  if (allSkipped.length > 0) {
    console.log("");
    for (const item of allSkipped) {
      console.log(ui.muted(`skipped ${item.name}: ${item.reason}`));
    }
  }
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

function printSignals(signals: AnalyzerSignal[]): void {
  if (signals.length === 0) {
    console.log(ui.success("No analyzer signals."));
    return;
  }

  const sorted = [...signals].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  console.log(`${signals.length} signal${signals.length === 1 ? "" : "s"}`);
  console.log("");
  console.log(
    ui.grid(
      ["#", "Severity", "Analyzer", "Rule", "Location", "Message"],
      sorted.map((signal, index) => [
        String(index + 1),
        colorSeverity(signal.severity),
        signal.analyzer,
        signal.ruleId,
        `${signal.range.file}:${signal.range.startLine}`,
        truncate(signal.message, 80)
      ])
    )
  );
}

function truncate(value: string, max: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}...` : single;
}

function colorSeverity(severity: Severity): string {
  switch (severity) {
    case "critical":
      return ui.critical(severity);
    case "high":
      return ui.error(severity);
    case "medium":
      return ui.warn(severity);
    case "low":
      return ui.info(severity);
    default:
      return ui.muted(severity);
  }
}
