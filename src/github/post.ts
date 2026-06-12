import type { ReviewReport } from "../types/reports.js";
import type { InlineCommentDraft, ScmProvider } from "../providers/scm/scm.interface.js";
import { buildDiffIndex, mapRangeToComment } from "./line-mapping.js";
import { buildSuggestionBlock } from "./suggestions.js";
import {
  buildInlineCommentBody,
  buildSummaryBody,
  extractPostedFingerprints,
  findSummaryComment,
  type SummaryOnlyFinding
} from "./comments.js";

export interface PostReviewParams {
  scm: ScmProvider;
  prNumber: number;
  report: ReviewReport;
  /** Commit the review is anchored to; defaults to the PR's current head. */
  headSha?: string;
}

export interface PostReviewResult {
  headSha: string;
  inlinePosted: number;
  skippedDuplicates: number;
  summaryOnly: number;
  suggestionsIncluded: number;
  summaryAction: "created" | "updated";
}

/**
 * Post a review report to a pull request: inline comments for findings that
 * map onto the diff, one stable summary comment that is updated in place on
 * reruns, and fingerprint-based dedupe against previously posted comments.
 */
export async function postReviewToPullRequest(params: PostReviewParams): Promise<PostReviewResult> {
  const { scm, prNumber, report } = params;

  const headSha = params.headSha ?? (await scm.getPullRequest(prNumber)).headSha;
  const files = await scm.listPullRequestFiles(prNumber);
  const diffIndex = buildDiffIndex(files);

  const priorInline = await scm.listReviewComments(prNumber);
  const postedFingerprints = extractPostedFingerprints(priorInline);

  const drafts: InlineCommentDraft[] = [];
  const summaryOnly: SummaryOnlyFinding[] = [];
  let skippedDuplicates = 0;
  let suggestionsIncluded = 0;
  const commentBudget = resolveCommentBudget(report);

  for (const finding of report.findings) {
    if (postedFingerprints.has(finding.fingerprint)) {
      skippedDuplicates += 1;
      continue;
    }

    const mapping = mapRangeToComment(finding.range, diffIndex);
    if (!mapping.mappable) {
      summaryOnly.push({ finding, reason: mapping.reason });
      continue;
    }

    // Findings are already ranked; once the configured inline comment budget
    // is reached, the rest belong in the summary rather than as comment noise.
    if (drafts.length >= commentBudget) {
      summaryOnly.push({ finding, reason: "inline comment budget reached" });
      continue;
    }

    // A suggestion replaces the commented range, so it may only ride on a
    // comment that covers the finding's full range exactly.
    const suggestion =
      mapping.comment.coverage === "full" ? buildSuggestionBlock(finding, diffIndex) : null;
    if (suggestion) {
      suggestionsIncluded += 1;
    }

    drafts.push({
      path: mapping.comment.path,
      body: buildInlineCommentBody(finding, suggestion),
      line: mapping.comment.line,
      side: mapping.comment.side,
      ...(mapping.comment.startLine !== undefined ? { startLine: mapping.comment.startLine } : {})
    });
  }

  const summaryBody = buildSummaryBody(report, summaryOnly, headSha);
  const issueComments = await scm.listIssueComments(prNumber);
  const existingSummary = findSummaryComment(issueComments);

  let summaryAction: PostReviewResult["summaryAction"];
  if (existingSummary) {
    await scm.updateIssueComment(existingSummary.id, summaryBody);
    summaryAction = "updated";
  } else {
    await scm.createIssueComment(prNumber, summaryBody);
    summaryAction = "created";
  }

  if (drafts.length > 0) {
    await scm.createReview(prNumber, headSha, undefined, drafts);
  }

  return {
    headSha,
    inlinePosted: drafts.length,
    skippedDuplicates,
    summaryOnly: summaryOnly.length,
    suggestionsIncluded,
    summaryAction
  };
}

const DEFAULT_COMMENT_BUDGET = 8;

/**
 * The repo config caps inline comments per review; security mode carries its
 * own, higher cap. Reports always embed their config, but a defensive default
 * keeps a malformed report from posting unbounded comments.
 */
function resolveCommentBudget(report: ReviewReport): number {
  const config = report.config;
  if (!config) {
    return DEFAULT_COMMENT_BUDGET;
  }
  if (config.mode === "security" && config.security?.commentBudget) {
    return config.security.commentBudget;
  }
  return config.commentBudget ?? DEFAULT_COMMENT_BUDGET;
}
