import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { loadServerEnv } from "../../config/env.js";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";
import { resolveServerConnection, serverPost, type ServerConnectionOptions } from "../server-client.js";
import { collectPrFeedback } from "../../feedback/github.js";
import type { FeedbackEventInput } from "../../memory/feedback-types.js";
import { GitHubScmProvider } from "../../providers/scm/github/index.js";

interface FeedbackImportOptions extends ServerConnectionOptions {
  pr?: string;
  repo?: string;
  file?: string;
}

interface IngestResponse {
  stored: number;
  duplicates: number;
  unknownFingerprints: number;
}

export function registerFeedbackCommand(program: Command): void {
  const feedback = program
    .command("feedback")
    .description("Collect and store finding feedback.");

  feedback
    .command("import")
    .description("Import accepted/dismissed/discussed feedback from a PR's reactions and replies, or from a JSONL file.")
    .option("--pr <number>", "pull request to collect feedback from (requires --repo or GITHUB_REPOSITORY)")
    .option("--repo <owner/name>", "repository for --pr and server-side feedback scoping (default: GITHUB_REPOSITORY)")
    .option("--file <path>", "JSONL file of feedback events to import instead")
    .option("--server <url>", "Hubolt server URL, defaults to HUBOLT_SERVER_URL")
    .option("--api-key <key>", "API key, defaults to HUBOLT_API_KEY")
    .action((options: FeedbackImportOptions) => {
      return runSafelyAsync(() => importFeedback(options));
    });
}

async function importFeedback(options: FeedbackImportOptions): Promise<void> {
  loadServerEnv();
  const connection = resolveServerConnection(options);

  let events: FeedbackEventInput[];
  let repoScope: string | undefined;

  if (options.file) {
    events = await readEventsFile(options.file);
    repoScope = options.repo || process.env.GITHUB_REPOSITORY;
    if (!repoScope) {
      throw new Error("No repository given for feedback import; pass --repo owner/name or set GITHUB_REPOSITORY");
    }
  } else if (options.pr) {
    const prNumber = Number.parseInt(options.pr, 10);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid pull request number: ${options.pr}`);
    }
    const repo = options.repo || process.env.GITHUB_REPOSITORY;
    if (!repo) {
      throw new Error("No repository given; pass --repo owner/name or set GITHUB_REPOSITORY");
    }
    repoScope = repo;
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) {
      throw new Error("No GitHub token available; set GITHUB_TOKEN or GH_TOKEN");
    }

    const scm = new GitHubScmProvider({ repoFullName: repo, token });
    const comments = await scm.listReviewComments(prNumber);
    events = collectPrFeedback(comments);
    console.log(`Collected ${events.length} event(s) from ${comments.length} review comment(s) on PR #${prNumber}.`);
  } else {
    throw new Error("Nothing to import; pass --pr <number> or --file <path>");
  }

  if (events.length === 0) {
    console.log("No feedback events to import.");
    return;
  }

  const result = await serverPost<IngestResponse>(connection, "/feedback", {
    events,
    ...(repoScope ? { repo: repoScope } : {})
  });

  console.log(ui.success("Feedback imported"));
  console.log(ui.table([
    ["Stored", String(result.stored)],
    ["Duplicates (already imported)", String(result.duplicates)],
    ["Unknown fingerprints (skipped)", String(result.unknownFingerprints)]
  ]));
}

async function readEventsFile(path: string): Promise<FeedbackEventInput[]> {
  const raw = await readFile(path, "utf8");
  const events: FeedbackEventInput[] = [];
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  for (const [index, line] of lines.entries()) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Line ${index + 1} of ${path} is not valid JSON`);
    }
    if (typeof parsed.fingerprint !== "string" || typeof parsed.verdict !== "string") {
      throw new Error(`Line ${index + 1} of ${path} needs string "fingerprint" and "verdict" fields`);
    }
    events.push({
      fingerprint: parsed.fingerprint,
      verdict: parsed.verdict as FeedbackEventInput["verdict"],
      source: typeof parsed.source === "string" ? parsed.source : "import",
      externalId: typeof parsed.externalId === "string" ? parsed.externalId : undefined,
      actor: typeof parsed.actor === "string" ? parsed.actor : undefined,
      note: typeof parsed.note === "string" ? parsed.note : undefined
    });
  }

  return events;
}
