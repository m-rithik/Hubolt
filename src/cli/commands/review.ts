import type { Command } from "commander";
import { resolveSettings } from "../../config/resolve.js";
import { InProcessReviewEventEmitter } from "../../core/events.js";
import { getChangedFiles, isGitRepository } from "../../core/git.js";
import { createReviewEvent } from "../../types/events.js";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";

interface ReviewOptions {
  staged?: boolean;
  base?: string;
  head?: string;
  config?: string;
}

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Resolve the local review scope for the current changes.")
    .option("--staged", "review staged changes instead of the working tree")
    .option("--base <ref>", "base ref for a commit-range review (requires --head)")
    .option("--head <ref>", "head ref for a commit-range review (requires --base)")
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

  const scope = options.base
    ? `${options.base}..${options.head}`
    : options.staged
      ? "staged changes"
      : "working tree";

  const emitter = new InProcessReviewEventEmitter();
  const repo = process.cwd();

  await emitter.emit(
    createReviewEvent({
      type: "review.started",
      repo,
      payload: { scope },
      redactionState: "metadataOnly"
    })
  );

  const settings = resolveSettings({ configPath: options.config });
  const changed = getChangedFiles({
    staged: options.staged,
    base: options.base,
    head: options.head
  });

  await emitter.emit(
    createReviewEvent({
      type: "review.completed",
      repo,
      payload: { scope, changedFiles: changed.length },
      redactionState: "metadataOnly"
    })
  );

  console.log(
    ui.section("Hubolt Review", [
      ["Scope", scope],
      ["Config", settings.configPath ?? "built-in defaults"],
      ["Mode", settings.mode],
      ["Provider", `${settings.llmProvider} (${settings.llmModel})`],
      ["Changed files", String(changed.length)]
    ])
  );

  if (changed.length === 0) {
    console.log(ui.muted("No changed files to review."));
    return;
  }

  const width = Math.max(...changed.map((file) => file.status.length));
  console.log("");
  for (const file of changed) {
    console.log(`  ${ui.label(file.status.padEnd(width))}  ${file.path}`);
  }

  console.log("");
  console.log(ui.muted("Analysis engine is not implemented yet; no findings were produced."));
}
