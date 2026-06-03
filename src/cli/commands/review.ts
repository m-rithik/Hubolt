import { join } from "node:path";
import type { Command } from "commander";
import { resolveSettings, type ResolvedSettings } from "../../config/resolve.js";
import { buildContext, type BuiltContext, type ReviewFile } from "../../core/context-builder.js";
import { createJsonlEventLog } from "../../core/event-log.js";
import { InProcessReviewEventEmitter } from "../../core/events.js";
import { isGitRepository } from "../../core/git.js";
import { runReviewPipeline, type ReviewResult } from "../../core/pipeline.js";
import { getLLMProvider } from "../../providers/llm/index.js";
import { createReviewEvent } from "../../types/events.js";
import type { Finding } from "../../types/finding.js";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";

interface ReviewOptions {
  staged?: boolean;
  base?: string;
  head?: string;
  config?: string;
  showContext?: boolean;
}

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Review the current local changes with the configured LLM provider.")
    .option("--staged", "review staged changes instead of the working tree")
    .option("--base <ref>", "base ref for a commit-range review (requires --head)")
    .option("--head <ref>", "head ref for a commit-range review (requires --base)")
    .option("--show-context", "print the context that would be sent to the model; no model call")
    .option("-c, --config <path>", "path to a Hubolt config file")
    .action((options: ReviewOptions) => {
      void runSafelyAsync(() => runReview(options));
    });
}

async function runReview(options: ReviewOptions): Promise<void> {
  if (Boolean(options.base) !== Boolean(options.head)) {
    throw new Error("Provide both --base and --head to review a commit range.");
  }

  if (!isGitRepository()) {
    throw new Error("Not a git repository. Run Hubolt inside a git working tree.");
  }

  const settings = resolveSettings({ configPath: options.config });
  const context = buildContext({
    staged: options.staged,
    base: options.base,
    head: options.head,
    config: settings.repo
  });

  if (options.showContext) {
    printContext(context);
    return;
  }

  const repo = process.cwd();
  const emitter = new InProcessReviewEventEmitter();
  const log = createJsonlEventLog(join(repo, ".hubolt", "logs", "events.jsonl"));
  emitter.on("*", (event) => log.append(event));

  await emitter.emit(
    createReviewEvent({
      type: "review.started",
      repo,
      payload: { scope: context.scope },
      redactionState: "metadataOnly"
    })
  );

  printHeader(context, settings);

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

  const llm = getLLMProvider(settings.llmProvider, { model: settings.llmModel });
  const result = await runReviewPipeline({ context, config: settings.repo, llm });

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
}

function printHeader(context: BuiltContext, settings: ResolvedSettings): void {
  console.log(
    ui.section("Hubolt Review", [
      ["Scope", context.scope],
      ["Config", settings.configPath ?? "built-in defaults"],
      ["Mode", settings.mode],
      ["Provider", `${settings.llmProvider} (${settings.llmModel})`],
      ["Files reviewed", String(context.reviewable.length)]
    ])
  );
}

function printResult(result: ReviewResult): void {
  console.log("");
  if (result.findings.length === 0) {
    console.log(ui.success("No findings at or above the configured severity threshold."));
  } else {
    for (const finding of result.findings) {
      console.log(renderFinding(finding));
      console.log("");
    }
  }

  const notes: string[] = [];
  if (result.droppedOutOfScope > 0) {
    notes.push(`${result.droppedOutOfScope} finding(s) dropped (outside changed files)`);
  }
  if (result.belowThreshold > 0) {
    notes.push(`${result.belowThreshold} finding(s) below threshold`);
  }
  if (notes.length > 0) {
    console.log(ui.muted(notes.join("; ")));
  }
}

function renderFinding(finding: Finding): string {
  const location = `${finding.range.file}:${finding.range.startLine}-${finding.range.endLine}`;
  const head = `${severityTag(finding)} ${finding.ruleId}  ${ui.label(location)}`;

  return [
    head,
    `  ${finding.title}`,
    ui.muted(`  Impact: ${finding.impact}`),
    ui.muted(`  Verify: ${finding.verification}`)
  ].join("\n");
}

function severityTag(finding: Finding): string {
  const text = `[${finding.severity}]`;
  if (finding.severity === "critical" || finding.severity === "high") {
    return ui.error(text);
  }
  if (finding.severity === "info" || finding.severity === "low") {
    return ui.muted(text);
  }
  return text;
}

function printContext(context: BuiltContext): void {
  console.log(ui.section("Hubolt Context", [["Scope", context.scope]]));
  console.log("");

  for (const file of context.reviewable) {
    console.log(`  ${ui.label("review")}  ${file.path}  ${rangeSummary(file)}`);
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
