import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cancel, intro, isCancel, outro, select } from "@clack/prompts";
import type { Command } from "commander";
import { isMap, parseDocument } from "yaml";
import { DEFAULT_CONFIG_FILE } from "../../config/defaults.js";
import { RepoConfigSchema, ReviewModeSchema, type RepoConfig } from "../../config/schema.js";
import { resolveSettings, type ResolvedSettings } from "../../config/resolve.js";
import { buildAnalyzerContext, runAnalyzers, selectAnalyzers } from "../../core/analyze.js";
import type { SkippedAnalyzer } from "../../core/analyze.js";
import { assertSafeCacheDir, createFileCache, createNoopCache, defaultCacheDir, type Cache } from "../../core/cache.js";
import { buildContext, type BuiltContext, type ReviewFile } from "../../core/context-builder.js";
import { buildSingleFileContext } from "../../core/single-file-reviewer.js";
import { createJsonlEventLog, defaultEventLogPath } from "../../core/event-log.js";
import { InProcessReviewEventEmitter } from "../../core/events.js";
import { getGitRoot, isGitRepository } from "../../core/git.js";
import { runReviewPipeline, type ReviewResult } from "../../core/pipeline.js";
import { retrieveCards, RETRIEVAL_BUDGET_TOKENS } from "../../memory/retrieval.js";
import type { MemoryCardData } from "../../memory/cards.js";
import { severityRank } from "../../core/rank.js";
import { withLlmCache } from "../../core/llm-cache.js";
import { buildReport, renderJsonReport, renderMarkdownReport } from "../../report/index.js";
import type { ReviewReport } from "../../types/reports.js";
import { buildIntegrations, dispatchIntegrations } from "../../integrations/registry.js";
import { buildIntegrationEvent } from "../../integrations/event.js";
import { getLLMProvider } from "../../providers/llm/index.js";
import { createReviewEvent } from "../../types/events.js";
import { CONTEXT_ADJACENT_TAG, SeveritySchema, type AnalyzerSignal, type Finding, type Severity } from "../../types/finding.js";
import type { LLMProvider } from "../../types/providers.js";
import { runSafelyAsync } from "../errors.js";
import { renderStarterConfig } from "../starter-config.js";
import { startSpinner } from "../spinner.js";
import { setColorEnabled, ui } from "../ui.js";
import { resolveServerConnection, serverGet } from "../server-client.js";

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
  /** Commander sets this to false when --no-llm is passed. */
  llm?: boolean;
  /** Commander sets this to false when --no-cache is passed. */
  cache?: boolean;
  ci?: boolean;
  json?: string;
  md?: string;
  filepath?: string;
}

interface ReviewModeOptions {
  config?: string;
  set?: string;
}

type ReviewMode = RepoConfig["mode"];

const REVIEW_MODE_OPTIONS: Array<{ value: ReviewMode; label: string; hint: string }> = [
  { value: "quiet", label: "quiet", hint: "Lowest noise; best for pre-commit checks." },
  { value: "balanced", label: "balanced", hint: "Default review signal and comment budget." },
  { value: "strict", label: "strict", hint: "More critical pass for careful review." },
  { value: "security", label: "security", hint: "Security findings only." }
];

/** Analyzer-only provider used by --no-llm: contributes no LLM findings. */
const NO_LLM_PROVIDER: LLMProvider = {
  name: "none",
  async review() {
    return [];
  }
};

interface RunOptions {
  /** Set process exit code when a finding reaches the fail-on severity (CI gate). */
  failOnExit?: boolean;
}

export function registerReviewCommand(program: Command): void {
  const review = program
    .command("review [filepath]")
    .description("Review the current local changes or a specific file with the configured LLM provider.")
    .option("--staged", "review staged changes instead of the working tree")
    .option("--base <ref>", "base ref for a commit-range review (requires --head)")
    .option("--head <ref>", "head ref for a commit-range review (requires --base)")
    .option("--show-context", "print the context that would be sent to the model; no model call")
    .option("--provider <name>", "override the LLM provider for this run (openai, claude, google)")
    .option("--model <model>", "override the LLM model for this run")
    .option("--security", "run a security-scoped review (security categories only)")
    .option("--no-llm", "skip the model; emit analyzer-only findings (no API key needed)")
    .option("--no-cache", "do not read or write the local result cache")
    .option("--ci", "deterministic, color-free output; exit non-zero past failOnSeverity")
    .option("--json <path>", "write a JSON report to this path")
    .option("--md <path>", "write a Markdown report to this path")
    .option("-c, --config <path>", "path to a Hubolt config file")
    .action((filepath: string | undefined, options: ReviewOptions) => {
      return runSafelyAsync(() => runReview({ ...options, filepath }));
    });

  review
    .command("mode")
    .description("Select and save the repository review mode.")
    .option("--set <mode>", "set mode without prompting (quiet|balanced|strict|security)")
    .option("-c, --config <path>", "path to a Hubolt config file")
    .action((options: ReviewModeOptions, command: Command) => {
      const parentOptions = command.parent?.opts<ReviewOptions>() ?? {};
      return runSafelyAsync(() => runReviewMode({ ...options, config: options.config ?? parentOptions.config }));
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
    .option("--no-llm", "skip the model; emit analyzer-only security findings (no API key needed)")
    .option("--no-cache", "do not read or write the local result cache")
    .option("--ci", "deterministic, color-free output for CI")
    .option("--json <path>", "write a JSON report to this path")
    .option("--md <path>", "write a Markdown report to this path")
    .option("-c, --config <path>", "path to a Hubolt config file")
    .action((options: ReviewOptions) => {
      return runSafelyAsync(() => runReview({ ...options, security: true }, { failOnExit: true }));
    });
}

async function runReview(options: ReviewOptions, runOptions: RunOptions = {}): Promise<void> {
  if (Boolean(options.base) !== Boolean(options.head)) {
    throw new Error("Provide both --base and --head to review a commit range.");
  }

  if (!isGitRepository()) {
    throw new Error("Not a git repository. Run Hubolt inside a git working tree.");
  }

  if (options.ci) {
    setColorEnabled(false);
  }

  const repo = getGitRoot();
  const baseSettings = resolveSettings({ cwd: options.config ? process.cwd() : repo, configPath: options.config });

  // Security mode comes from --security/the security command, config mode, or
  // the explicit security.enabled toggle.
  const securityMode = Boolean(options.security) || baseSettings.repo.mode === "security" || baseSettings.repo.security.enabled;
  const repoConfig: RepoConfig = securityMode ? { ...baseSettings.repo, mode: "security" } : baseSettings.repo;
  const settings: ResolvedSettings = { ...baseSettings, mode: repoConfig.mode, repo: repoConfig };

  // Gate severity: security runs use security.failOnSeverity (default "high"),
  // general --ci runs use the top-level failOnSeverity (default "critical").
  // --fail-on overrides either. All have schema defaults, so never undefined.
  const failOn =
    parseFailOn(options.failOn) ??
    (securityMode ? settings.repo.security.failOnSeverity : settings.repo.failOnSeverity);
  const useLlm = options.llm !== false;
  const cacheEnabled = options.cache !== false;
  const cacheRoot = cacheEnabled ? assertSafeCacheDir(baseSettings.cacheDir ?? defaultCacheDir(repo), { repoRoot: repo }) : "";
  const analyzerCache: Cache = cacheEnabled ? createFileCache(join(cacheRoot, "analyzers")) : createNoopCache();
  const llmCache: Cache = cacheEnabled ? createFileCache(join(cacheRoot, "llm")) : createNoopCache();
  const providerName = options.provider ?? settings.llmProvider;
  const modelName = options.model ?? settings.llmModel;
  const providerLabel = useLlm ? `${providerName} (${modelName})` : "none (analyzers only)";
  const context = options.filepath
    ? buildSingleFileContext({ filepath: options.filepath, cwd: repo })
    : await buildContext({
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

  printHeader(context, settings, providerLabel);

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

  const analyzerSignals = await collectAnalyzerSignals(context, settings, emitter, repo, securityMode, analyzerCache, !options.ci);

  // Pull org-scoped team memory cards from the server when one is configured.
  // Local runs cannot identify the server-side repo, so only org-scoped cards
  // (maintainer style cards, org-wide rule calibration) apply here.
  const memory = useLlm ? await fetchTeamMemory(analyzerSignals.map((signal) => signal.ruleId)) : [];

  const baseLlm = useLlm ? getLLMProvider(providerName, { model: modelName }) : NO_LLM_PROVIDER;
  const llm = useLlm ? withLlmCache(baseLlm, llmCache, modelName) : baseLlm;
  const spinnerLabel = useLlm
    ? `Reviewing ${context.reviewable.length} file(s) with ${providerName}...`
    : `Analyzing ${context.reviewable.length} file(s) (no model call)...`;
  if (useLlm) {
    console.log(ui.muted(`LLM: calling ${providerName} (${modelName})`));
  }
  const spinner = options.ci ? null : startSpinner(spinnerLabel);
  let result;
  try {
    result = await runReviewPipeline({ context, config: settings.repo, llm, analyzerSignals, memory });
  } catch (error) {
    spinner?.stop();
    await emitter.emit(
      createReviewEvent({
        type: "review.completed",
        repo,
        payload: { scope: context.scope, findings: 0, error: true },
        redactionState: "metadataOnly"
      })
    );
    throw contextualizeReviewError(error, useLlm);
  }
  spinner?.stop();

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

  const report = buildReport({
    scope: context.scope,
    config: settings.repo,
    provider: useLlm ? providerName : "none",
    model: useLlm ? modelName : "none",
    result,
    analyzerSignals
  });
  writeReports(options, report);
  await dispatchReviewIntegrations(settings.repo, report);

  if (runOptions.failOnExit || options.ci) {
    applyFailOnGate(result, failOn, securityMode ? "Security gate" : "CI gate");
  }
}

async function runReviewMode(options: ReviewModeOptions): Promise<void> {
  const configPath = resolve(process.cwd(), options.config ?? DEFAULT_CONFIG_FILE);
  const current = readCurrentMode(configPath);

  const nextMode = options.set ? parseReviewMode(options.set) : await promptReviewMode(current);
  if (!nextMode) {
    return;
  }

  writeReviewModeConfig(configPath, nextMode);

  if (options.set) {
    console.log(ui.success(`Review mode set to ${nextMode} in ${configPath}`));
  } else {
    outro(`Review mode set to ${nextMode} in ${configPath}`);
  }
}

function readCurrentMode(configPath: string): ReviewMode {
  const parsed = existsSync(configPath)
    ? RepoConfigSchema.parse(parseDocument(readFileSync(configPath, "utf8")).toJS())
    : RepoConfigSchema.parse({});
  return parsed.mode;
}

async function promptReviewMode(current: ReviewMode): Promise<ReviewMode | null> {
  intro("Hubolt review mode");

  const selectedMode = await select({
    message: "Review mode",
    options: REVIEW_MODE_OPTIONS,
    initialValue: current
  });
  if (isCancel(selectedMode)) {
    cancel("Review mode unchanged.");
    return null;
  }

  return selectedMode;
}

function parseReviewMode(value: string): ReviewMode {
  const parsed = ReviewModeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid review mode: ${value}. Use quiet, balanced, strict, or security.`);
  }
  return parsed.data;
}

function contextualizeReviewError(error: unknown, useLlm: boolean): Error {
  if (!useLlm) {
    return error instanceof Error ? error : new Error("Analyzer-only review failed.");
  }

  const message = error instanceof Error ? error.message : "unknown provider error";
  return new Error(`LLM review failed after analyzer phase completed: ${message}`);
}

export function writeReviewModeConfig(configPath: string, mode: string): void {
  const nextMode = parseReviewMode(mode);
  const raw = existsSync(configPath) ? readFileSync(configPath, "utf8") : renderStarterConfig();
  const document = parseDocument(raw);

  if (document.errors.length > 0) {
    throw new Error(`Cannot update ${configPath}: invalid YAML.`);
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error(`Cannot update ${configPath}: expected a YAML mapping at the top level.`);
  }

  document.set("mode", nextMode);
  RepoConfigSchema.parse(document.toJS());
  writeFileSync(configPath, String(document));
}

/** Write JSON and/or Markdown reports when --json/--md were provided. */
function writeReports(options: ReviewOptions, report: ReviewReport): void {
  if (!options.json && !options.md) {
    return;
  }

  if (options.json) {
    writeFileSync(options.json, renderJsonReport(report));
    console.log(ui.muted(`Wrote JSON report to ${options.json}`));
  }
  if (options.md) {
    writeFileSync(options.md, renderMarkdownReport(report));
    console.log(ui.muted(`Wrote Markdown report to ${options.md}`));
  }
}

/**
 * Deliver a completed review to any configured integrations. Best-effort: no
 * configured integration is a no-op, and any failure is reported as a line,
 * never thrown into the review.
 */
async function dispatchReviewIntegrations(config: RepoConfig, report: ReviewReport): Promise<void> {
  const adapters = buildIntegrations(config);
  if (adapters.length === 0) {
    return;
  }

  try {
    const results = await dispatchIntegrations(buildIntegrationEvent(report), adapters);
    for (const result of results) {
      console.log(
        result.ok
          ? ui.muted(`Integration ${result.adapter}: delivered`)
          : ui.muted(`Integration ${result.adapter}: ${result.error ?? "failed"}`)
      );
    }
  } catch (error) {
    console.log(ui.muted(`Integration dispatch failed: ${error instanceof Error ? error.message : "error"}`));
  }
}

/**
 * Set the process exit code (CI gate) when any finding reaches the fail-on
 * severity. Prints a clear pass/fail line either way.
 */
function applyFailOnGate(result: ReviewResult, failOn: Severity, label: string): void {
  const threshold = severityRank(failOn);
  const breaching = result.findings.filter((finding) => severityRank(finding.severity) >= threshold);

  console.log("");
  if (breaching.length > 0) {
    process.exitCode = 1;
    console.log(ui.error(`${label} failed: ${breaching.length} finding(s) at or above "${failOn}".`));
  } else {
    console.log(ui.success(`${label} passed: no findings at or above "${failOn}".`));
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
/**
 * Fetch team memory cards from a configured Hubolt server and select those
 * that fit the prompt budget. Best effort: a missing server, missing
 * credentials, or any request failure yields no cards and never fails the
 * review. Repo is unknown locally, so only org-scoped cards are eligible.
 */
async function fetchTeamMemory(ruleIds: string[]): Promise<string[]> {
  let connection;
  try {
    connection = resolveServerConnection({});
  } catch {
    return []; // no server configured; local review runs without memory
  }

  try {
    const { cards } = await serverGet<{ cards: MemoryCardData[] }>(connection, "/memory/cards");
    const selected = retrieveCards(cards, { ruleIds, budgetTokens: RETRIEVAL_BUDGET_TOKENS });
    if (selected.length > 0) {
      console.log(ui.muted(`Team memory: applied ${selected.length} card(s) from the server.`));
    }
    return selected.map((entry) => entry.card.body);
  } catch (error) {
    console.log(ui.muted(`Team memory unavailable: ${error instanceof Error ? error.message : "request failed"}`));
    return [];
  }
}

async function collectAnalyzerSignals(
  context: BuiltContext,
  settings: ResolvedSettings,
  emitter: InProcessReviewEventEmitter,
  repo: string,
  securityMode: boolean,
  cache: Cache,
  interactive: boolean
): Promise<AnalyzerSignal[]> {
  const { names, skipped: notSelected } = selectAnalyzers(settings.repo, { securityMode });
  if (names.length === 0) {
    printSkippedAnalyzers(notSelected);
    return [];
  }

  const analyzerContext = buildAnalyzerContext(context, { repoRoot: repo, config: settings.repo });
  // Analysis (TypeScript compile, secret scan) is the slow pre-LLM step, so it
  // gets its own spinner rather than a silent pause.
  const spinner = interactive
    ? startSpinner(`Analyzing ${context.reviewable.length} file(s) with ${names.join(", ")}...`)
    : null;
  let analyzed;
  try {
    analyzed = await runAnalyzers(analyzerContext, names, { cache });
  } finally {
    spinner?.stop();
  }
  const { signals, ran, skipped } = analyzed;
  const allSkipped = [...notSelected, ...skipped];

  await emitter.emit(
    createReviewEvent({
      type: "analyzer.completed",
      repo,
      payload: { ran, skipped: allSkipped, signals: signals.length },
      redactionState: "metadataOnly"
    })
  );

  if (ran.length > 0) {
    console.log("");
    console.log(ui.muted(`Analyzers: ${ran.join(", ")} (${signals.length} signal${signals.length === 1 ? "" : "s"})`));
  }
  printSkippedAnalyzers(allSkipped);

  return signals;
}

function printSkippedAnalyzers(skipped: SkippedAnalyzer[]): void {
  for (const item of skipped) {
    console.log(ui.muted(`skipped ${item.name}: ${item.reason}`));
  }
}

function printHeader(context: BuiltContext, settings: ResolvedSettings, providerLabel: string): void {
  const title = settings.mode === "security" ? "Hubolt Security Review" : "Hubolt Review";
  console.log(
    ui.section(title, [
      ["Scope", context.scope],
      ["Config", settings.configPath ?? "built-in defaults"],
      ["Mode", settings.mode],
      ["Provider", providerLabel],
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
      console.log(ui.muted(`   ${finding.ruleId} [${finding.source}]`));
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
