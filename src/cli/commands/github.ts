import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { loadServerEnv } from "../../config/env.js";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";
import { parseReport, type ReviewReport } from "../../types/reports.js";
import { GitHubScmProvider } from "../../providers/scm/github/index.js";
import { buildDiffIndex, mapRangeToComment } from "../../github/line-mapping.js";
import { postReviewToPullRequest } from "../../github/post.js";

interface GitHubCommandOptions {
  from: string;
  pr: string;
  repo?: string;
  head?: string;
}

export function registerGitHubCommand(program: Command): void {
  const github = program
    .command("github")
    .description("Post review results to GitHub pull requests.");

  github
    .command("post")
    .description("Post a review summary, inline comments, and suggestion blocks to a pull request.")
    .requiredOption("--pr <number>", "pull request number")
    .requiredOption("--from <path>", "JSON review report to post")
    .option("--repo <owner/name>", "repository (default: GITHUB_REPOSITORY env)")
    .option("--head <sha>", "head commit to anchor the review to (default: current PR head)")
    .action((options: GitHubCommandOptions) => {
      return runSafelyAsync(() => runPost(options));
    });

  github
    .command("map-lines")
    .description("Debug diff line mapping for a report without posting anything.")
    .requiredOption("--pr <number>", "pull request number")
    .requiredOption("--from <path>", "JSON review report to map")
    .option("--repo <owner/name>", "repository (default: GITHUB_REPOSITORY env)")
    .action((options: GitHubCommandOptions) => {
      return runSafelyAsync(() => runMapLines(options));
    });
}

async function runPost(options: GitHubCommandOptions): Promise<void> {
  const { scm, prNumber, report } = await loadCommandContext(options);

  const result = await postReviewToPullRequest({
    scm,
    prNumber,
    report,
    headSha: options.head
  });

  console.log(ui.title(`Posted review to PR #${prNumber}`));
  console.log(`Summary comment: ${result.summaryAction}`);
  console.log(`Inline comments posted: ${result.inlinePosted}`);
  console.log(`Suggestions included: ${result.suggestionsIncluded}`);
  console.log(`Skipped (already posted): ${result.skippedDuplicates}`);
  console.log(`Summary-only findings: ${result.summaryOnly}`);
  console.log(`Anchored to head: ${result.headSha}`);
}

async function runMapLines(options: GitHubCommandOptions): Promise<void> {
  const { scm, prNumber, report } = await loadCommandContext(options);

  const files = await scm.listPullRequestFiles(prNumber);
  const diffIndex = buildDiffIndex(files);

  console.log(ui.title(`Line mapping for PR #${prNumber}`));

  let inline = 0;
  let summaryOnly = 0;

  for (const finding of report.findings) {
    const location = `${finding.range.file}:${finding.range.startLine}-${finding.range.endLine}`;
    const mapping = mapRangeToComment(finding.range, diffIndex);

    if (mapping.mappable) {
      inline += 1;
      const anchor =
        mapping.comment.startLine !== undefined
          ? `lines ${mapping.comment.startLine}-${mapping.comment.line}`
          : `line ${mapping.comment.line}`;
      const coverage = mapping.comment.coverage === "full" ? "" : " (degraded to end line)";
      console.log(`inline    ${location} -> ${anchor} ${mapping.comment.side}${coverage} - ${finding.title}`);
    } else {
      summaryOnly += 1;
      console.log(`summary   ${location} (${mapping.reason}) - ${finding.title}`);
    }
  }

  console.log("");
  console.log(`Inline-safe: ${inline}, summary-only: ${summaryOnly}, total: ${report.findings.length}`);
}

async function loadCommandContext(options: GitHubCommandOptions): Promise<{
  scm: GitHubScmProvider;
  prNumber: number;
  report: ReviewReport;
}> {
  loadServerEnv();

  const prNumber = Number.parseInt(options.pr, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid pull request number: ${options.pr}`);
  }

  const repo = options.repo || process.env.GITHUB_REPOSITORY;
  if (!repo) {
    throw new Error("No repository given; pass --repo owner/name or set GITHUB_REPOSITORY");
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new Error("No GitHub token available; set GITHUB_TOKEN or GH_TOKEN");
  }

  const raw = await readFile(options.from, "utf8");
  const report = parseReport(raw, options.from);

  const scm = new GitHubScmProvider({ repoFullName: repo, token });

  return { scm, prNumber, report };
}
