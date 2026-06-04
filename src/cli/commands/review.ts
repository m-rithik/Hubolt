import type { Command } from "commander";
import type { RepoConfig } from "../../config/schema.js";
import { resolveSettings, type ResolvedSettings } from "../../config/resolve.js";
import { buildAnalyzerContext, runAnalyzers, selectAnalyzers } from "../../core/analyze.js";
import { buildContext, type BuiltContext, type ReviewFile } from "../../core/context-builder.js";
import { createJsonlEventLog, defaultEventLogPath } from "../../core/event-log.js";
import { InProcessReviewEventEmitter } from "../../core/events.js";
import { getGitRoot, isGitRepository } from "../../core/git.js";
import { runReviewPipeline, type ReviewResult } from "../../core/pipeline.js";
import { severityRank } from "../../core/rank.js";
import { getLLMProvider } from "../../providers/llm/index.js";
import { createReviewEvent } from "../../types/events.js";
import { CONTEXT_ADJACENT_TAG, SeveritySchema, type AnalyzerSignal, type Finding, type Severity } from "../../types/finding.js";
import { runSafelyAsync } from "../errors.js";
import { startSpinner } from "../spinner.js";
import { ui } from "../ui.js";

interface ReviewOptions {
  staged?: boolean;
  base?: string;
  head?: string;
  config?: string;
  showContext?: boolean;
  provider?: string;
  model?: string;
  security?: boolean;
  failOn?: string;
}

interface RunOptions {
  /** Set process exit code when a finding reaches the fail-on severity (CI gate). */
  failOnExit?: boolean;
}

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Review the current local changes with the configured LLM provider.")
    .option("--staged", "review staged changes instead of the working tree")
    .option("--base <ref>", "base ref for a commit-range review (requires --head)")
    .option("--head <ref>", "head ref for a commit-range review (requires --base)")
    .option("--show-context", "print the context that would be sent to the model; no model call")
    .option("--provider <name>", "override the LLM provider for this run (openai, claude, google)")
    .option("--model <model>", "override the LLM model for this run")
    .option("--security", "run a security-scoped review (security categories only)")
    .option("-c, --config <path>", "path to a Hubolt config file")
    .action((options: ReviewOptions) => {
      void runSafelyAsync(() => runReview(options));
    });
}

export function registerSecurityCommand(program: Command): void {
  program
    .command("security")
    .description("Run a security-scoped review and fail when findings reach a severity threshold.")
    .option("--staged", "review staged changes instead of the working tree")
    .option("--base <ref>", "base ref for a commit-range review (requires --head)")
    .option("--head <ref>", "head ref for a commit-range review (requires --base)")
    .option("--fail-on <severity>", "exit non-zero when a finding reaches this severity (info|low|medium|high|critical)")
    .option("--provider <name>", "override the LLM provider for this run (openai, claude, google)")
    .option("--model <model>", "override the LLM model for this run")
    .option("-c, --config <path>", "path to a Hubolt config file")
    .action((options: ReviewOptions) => {
      void runSafelyAsync(() => runReview({ ...options, security: true }, { failOnExit: true }));
    });
}

async function runReview(options: ReviewOptions, runOptions: RunOptions = {}): Promise<void> {
  if (Boolean(options.base) !== Boolean(options.head)) {
    throw new Error("Provide both --base and --head to review a commit range.");
  }

  if (!isGitRepository()) {
    throw new Error("Not a git repository. Run Hubolt inside a git working tree.");
  }

  const repo = getGitRoot();
  const baseSettings = resolveSettings({ cwd: options.config ? process.cwd() : repo, configPath: options.config });

  // Security mode comes from --security/the security command, config mode, or
  // the explicit security.enabled toggle.
  const securityMode = Boolean(options.security) || baseSettings.repo.mode === "security" || baseSettings.repo.security.enabled;
  const repoConfig: RepoConfig = securityMode ? { ...baseSettings.repo, mode: "security" } : baseSettings.repo;
  const settings: ResolvedSettings = { ...baseSettings, mode: repoConfig.mode, repo: repoConfig };

  const failOn = parseFailOn(options.failOn) ?? settings.repo.security.failOnSeverity;
  const providerName = options.provider ?? settings.llmProvider;
  const modelName = options.model ?? settings.llmModel;
  const context = await buildContext({
    cwd: repo,
    staged: options.staged,
    base: options.base,
    head: options.head,
    config: settings.repo
  });

  if (options.showContext) {
    printContext(context);
    return;
  }

  const emitter = new InProcessReviewEventEmitter();
  const log = createJsonlEventLog(defaultEventLogPath(repo));
  emitter.on("*", (event) => log.append(event));

  await emitter.emit(
    createReviewEvent({
      type: "review.started",
      repo,
      payload: { scope: context.scope },
      redactionState: "metadataOnly"
    })
  );

  printHeader(context, settings, providerName, modelName);

  if (context.reviewable.length === 0) {
    await emitter.emit(
      createReviewEvent({
        type: "review.completed",
        repo,
        payload: { scope: context.scope, findings: 0 },
        redactionState: "metadataOnly"
      })
    );
    console.log(ui.muted("No reviewable files in scope."));
    return;
  }

  const analyzerSignals = await collectAnalyzerSignals(context, settings, emitter, repo, securityMode);

  const llm = getLLMProvider(providerName, { model: modelName });
  const spinner = startSpinner(`Reviewing ${context.reviewable.length} file(s) with ${providerName}...`);
  let result;
  try {
    result = await runReviewPipeline({ context, config: settings.repo, llm, analyzerSignals });
  } catch (error) {
    spinner.stop();
    await emitter.emit(
      createReviewEvent({
        type: "review.completed",
        repo,
        payload: { scope: context.scope, findings: 0, error: true },
        redactionState: "metadataOnly"
      })
    );
    throw error;
  }
  spinner.stop();

  for (const finding of result.findings) {
    await emitter.emit(
      createReviewEvent({
        type: "finding.created",
        repo,
        payload: {
          fingerprint: finding.fingerprint,
          ruleId: finding.ruleId,
          severity: finding.severity,
          file: finding.range.file
        },
        redactionState: "metadataOnly"
      })
    );
  }

  await emitter.emit(
    createReviewEvent({
      type: "review.completed",
      repo,
      payload: { scope: context.scope, findings: result.findings.length },
      redactionState: "metadataOnly"
    })
  );

  printResult(result);

  if (runOptions.failOnExit) {
    applyFailOnGate(result, failOn);
  }
}

/**
 * Set the process exit code (CI gate) when any finding reaches the fail-on
 * severity. Prints a clear pass/fail line either way.
 */
function applyFailOnGate(result: ReviewResult, failOn: Severity): void {
  const threshold = severityRank(failOn);
  const breaching = result.findings.filter((finding) => severityRank(finding.severity) >= threshold);

  console.log("");
  if (breaching.length > 0) {
    process.exitCode = 1;
    console.log(ui.error(`Security gate failed: ${breaching.length} finding(s) at or above "${failOn}".`));
  } else {
    console.log(ui.success(`Security gate passed: no findings at or above "${failOn}".`));
  }
}

function parseFailOn(value: string | undefined): Severity | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = SeveritySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid --fail-on severity: ${value}. Use info, low, medium, high, or critical.`);
  }
  return parsed.data;
}

/**
 * Run the configured analyzers over the changed files and return their signals.
 * Failures are isolated by runAnalyzers, so this never throws the review; it
 * prints a one-line summary and emits an analyzer.completed event.
 */
async function collectAnalyzerSignals(
  context: BuiltContext,
  settings: ResolvedSettings,
  emitter: InProcessReviewEventEmitter,
  repo: string,
  securityMode: boolean
): Promise<AnalyzerSignal[]> {
  const { names } = selectAnalyzers(settings.repo, { securityMode });
  if (names.length === 0) {
    return [];
  }

  const analyzerContext = buildAnalyzerContext(context, { repoRoot: repo, config: settings.repo });
  const { signals, ran } = await runAnalyzers(analyzerContext, names);

  await emitter.emit(
    createReviewEvent({
      type: "analyzer.completed",
      repo,
      payload: { ran, signals: signals.length },
      redactionState: "metadataOnly"
    })
  );

  if (ran.length > 0) {
    console.log("");
    console.log(ui.muted(`Analyzers: ${ran.join(", ")} (${signals.length} signal${signals.length === 1 ? "" : "s"})`));
  }

  return signals;
}

function printHeader(
  context: BuiltContext,
  settings: ResolvedSettings,
  provider: string,
  model: string
): void {
  const title = settings.mode === "security" ? "Hubolt Security Review" : "Hubolt Review";
  console.log(
    ui.section(title, [
      ["Scope", context.scope],
      ["Config", settings.configPath ?? "built-in defaults"],
      ["Mode", settings.mode],
      ["Provider", `${provider} (${model})`],
      ["Files reviewed", String(context.reviewable.length)]
    ])
  );
}

const SEVERITY_ORDER: Finding["severity"][] = ["critical", "high", "medium", "low", "info"];

function printResult(result: ReviewResult): void {
  console.log("");

  if (result.findings.length === 0) {
    console.log(ui.success("No findings at or above the configured severity threshold."));
  } else {
    console.log(severityBreakdown(result.findings));
    console.log("");
    console.log(
      ui.grid(
        ["#", "Severity", "Category", "Location", "Title"],
        result.findings.map((finding, index) => [
          String(index + 1),
          colorSeverity(finding.severity),
          finding.category,
          `${finding.range.file}:${finding.range.startLine}-${finding.range.endLine}`,
          finding.title
        ])
      )
    );
    console.log("");
    result.findings.forEach((finding, index) => {
      const adjacent = finding.tags.includes(CONTEXT_ADJACENT_TAG) ? ui.muted(" (adjacent to changed lines)") : "";
      console.log(`${index + 1}. ${colorSeverity(finding.severity)} ${finding.title}${adjacent}`);
      const source = finding.source === "llm" ? "" : ` [${finding.source}]`;
      console.log(ui.muted(`   ${finding.ruleId}${source}`));
      console.log(ui.muted(`   Impact: ${finding.impact}`));
      if (finding.suggestion) {
        console.log(ui.muted(`   Fix:    ${finding.suggestion}`));
      }
      console.log(ui.muted(`   Verify: ${finding.verification}`));
      console.log("");
    });
  }

  const notes: string[] = [];
  if (result.droppedInvalid > 0) {
    notes.push(`${result.droppedInvalid} finding(s) dropped (invalid range or missing evidence)`);
  }
  if (result.droppedOutOfScope > 0) {
    notes.push(`${result.droppedOutOfScope} finding(s) dropped (outside changed files)`);
  }
  if (result.belowThreshold > 0) {
    notes.push(`${result.belowThreshold} finding(s) below threshold`);
  }
  if (result.promotedFromAnalyzers > 0) {
    notes.push(`${result.promotedFromAnalyzers} analyzer signal(s) promoted to findings`);
  }
  if (result.droppedByMode > 0) {
    notes.push(`${result.droppedByMode} non-security finding(s) hidden by security mode`);
  }
  if (notes.length > 0) {
    console.log(ui.muted(notes.join("; ")));
  }
}

function severityBreakdown(findings: Finding[]): string {
  const counts = new Map<Finding["severity"], number>();
  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }

  const parts = SEVERITY_ORDER.filter((severity) => counts.has(severity)).map(
    (severity) => `${colorSeverity(severity)} ${counts.get(severity)}`
  );

  return `${findings.length} finding${findings.length === 1 ? "" : "s"}  (${parts.join("  ")})`;
}

function colorSeverity(severity: Finding["severity"]): string {
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

function printContext(context: BuiltContext): void {
  console.log(ui.section("Hubolt Context", [["Scope", context.scope]]));
  console.log("");

  for (const file of context.reviewable) {
    console.log(`  ${ui.label("review")}  ${file.path}  ${rangeSummary(file)}`);
    if (file.regions && file.regions.length > 0) {
      const regions = file.regions.map((region) => `${region.kind} ${region.name}`).join(", ");
      console.log(ui.muted(`           regions: ${regions}`));
    }
  }
  for (const file of context.files.filter((entry) => entry.skipped)) {
    console.log(ui.muted(`  skip    ${file.path}  (${file.skipped})`));
  }

  console.log("");
  console.log(ui.muted("Context only; no model call was made."));
}

function rangeSummary(file: ReviewFile): string {
  if (file.changedRanges.length === 0) {
    return ui.muted("(whole file)");
  }
  return ui.muted(file.changedRanges.map((range) => `${range.startLine}-${range.endLine}`).join(", "));
}
