import { parse as parseYaml } from "yaml";
import type { PrismaClient } from "../generated/prisma/index.js";
import type { LLMProvider } from "../types/providers.js";
import type { ScmProvider } from "../providers/scm/scm.interface.js";
import type { RepoConfig } from "../config/schema.js";
import { RepoConfigSchema } from "../config/schema.js";
import { DEFAULT_CONFIG_FILE } from "../config/defaults.js";
import { runReviewPipeline } from "../core/pipeline.js";
import { buildReport } from "../report/build.js";
import { postReviewToPullRequest, type PostReviewResult } from "../github/post.js";
import { buildHostedContext } from "./review-context.js";
import type { ReviewJob } from "./review-jobs.js";
import { collectPrFeedback } from "../feedback/github.js";
import { applyFeedback } from "../memory/apply.js";
import { FeedbackService } from "../server/services/feedback.js";
import { MemoryService } from "../server/services/memory.js";

const MEMORY_RULE_LOOKBACK_LIMIT = 50;

export interface ReviewProcessorDeps {
  db: PrismaClient;
  createScm: (job: ReviewJob) => ScmProvider;
  createLlm: (config: RepoConfig) => LLMProvider;
}

export type ReviewJobOutcome =
  | { status: "skipped"; reason: string }
  | {
      status: "completed";
      reviewId: string;
      findingCount: number;
      incremental: boolean;
      /** Null when posting to the SCM failed; the review is still persisted. */
      posted: PostReviewResult | null;
      postError?: string;
      feedbackCollected?: number;
      suppressedByFeedback?: number;
      memoryCardsUsed?: number;
    };

/**
 * Process one queued pull request review: fetch the diff, build hosted
 * context, run the core pipeline, persist the review, and post the results.
 * Synchronize events review incrementally - only files changed since the
 * last reviewed head - falling back to a full review when the comparison is
 * unavailable (for example after a force push).
 */
export async function processReviewJob(job: ReviewJob, deps: ReviewProcessorDeps): Promise<ReviewJobOutcome> {
  const scm = deps.createScm(job);

  const pr = await scm.getPullRequest(job.prNumber);
  if (pr.headSha !== job.headSha) {
    return { status: "skipped", reason: "pull request head moved; a newer job supersedes this one" };
  }

  const state = await deps.db.pullRequestState.findUnique({
    where: { repoId_prNumber: { repoId: job.repoId, prNumber: job.prNumber } }
  });

  if (state?.headSha === job.headSha) {
    return { status: "skipped", reason: "head already reviewed" };
  }

  let onlyPaths: Set<string> | undefined;
  if (state && state.headSha !== job.headSha) {
    const changedSince = await scm.compareCommits(state.headSha, job.headSha);
    if (changedSince) {
      onlyPaths = new Set(changedSince);
    }
  }

  const config = await loadHostedConfig(scm, job.headSha);
  const files = await scm.listPullRequestFiles(job.prNumber);

  const feedbackService = new FeedbackService(deps.db);
  const memoryService = new MemoryService(deps.db);

  // Harvest feedback left on previously posted comments before re-reviewing,
  // so this very run already benefits from it. Best effort: feedback must
  // never fail a review.
  let feedbackCollected = 0;
  try {
    const comments = await scm.listReviewComments(job.prNumber);
    const events = collectPrFeedback(comments);
    if (events.length > 0) {
      const ingested = await feedbackService.ingest(job.orgId, events, { repoId: job.repoId });
      feedbackCollected = ingested.stored;
    }
  } catch (error) {
    console.warn(`Feedback collection failed for PR #${job.prNumber}:`, error instanceof Error ? error.message : error);
  }

  // Team memory rides along in the prompt as compact, fenced cards.
  let memoryCards: string[] = [];
  try {
    const memoryRuleIds = await collectMemoryRuleIds(deps.db, job, config);
    const retrieved = await memoryService.retrieve(job.orgId, job.repoId, memoryRuleIds);
    memoryCards = retrieved.map((entry) => entry.card.body);
  } catch (error) {
    console.warn(`Memory retrieval failed for PR #${job.prNumber}:`, error instanceof Error ? error.message : error);
  }

  const context = await buildHostedContext({
    files,
    fetchContent: (path) => scm.getFileContent(path, job.headSha),
    ignoreGlobs: config.ignore,
    maxFileSizeKb: config.maxFileSizeKb,
    maxContextTokens: config.maxContextTokens,
    onlyPaths,
    scope: `pr #${job.prNumber} @ ${job.headSha}`
  });

  const llm = deps.createLlm(config);
  const result = await runReviewPipeline({ context, config, llm, memory: memoryCards });

  // Apply team feedback history: suppress what the team has repeatedly
  // rejected, demote doubtful classes to the summary, calibrate confidence.
  let applied = {
    kept: result.findings,
    summaryOnly: [] as Array<{ finding: (typeof result.findings)[number]; reason: string }>,
    suppressed: [] as Array<{ finding: (typeof result.findings)[number]; reason: string }>,
    calibrationsApplied: 0
  };
  try {
    const lookup = await feedbackService.lookup(
      job.orgId,
      result.findings.map((finding) => finding.fingerprint),
      result.findings.map((finding) => finding.ruleId),
      { repoId: job.repoId }
    );
    applied = applyFeedback(result.findings, lookup);
  } catch (error) {
    console.warn(`Feedback application failed for PR #${job.prNumber}:`, error instanceof Error ? error.message : error);
  }

  const report = buildReport({
    result: { ...result, findings: applied.kept },
    config,
    scope: context.scope,
    provider: config.providers.llm,
    model: config.providers.model,
    analyzerSignals: []
  });

  // Persist what survives suppression (kept + demoted); fully suppressed
  // findings are intentionally not stored as current findings again.
  const persisted = dedupeFindingsByFingerprint([
    ...applied.kept,
    ...applied.summaryOnly.map((entry) => entry.finding)
  ]);
  const reviewId = await persistReview(deps.db, job, persisted, config);

  // A posting failure must not fail the job: the LLM has already been paid
  // for and the review is persisted, so a retry would re-bill the model for
  // nothing. Comment markers make the next push self-healing instead.
  let posted: PostReviewResult | null = null;
  let postError: string | undefined;
  try {
    posted = await postReviewToPullRequest({
      scm,
      prNumber: job.prNumber,
      report,
      headSha: job.headSha,
      extraSummaryOnly: applied.summaryOnly
    });
  } catch (error) {
    postError = error instanceof Error ? error.message : "Unknown posting error";
    console.error(`Failed to post review for PR #${job.prNumber} (${job.repoFullName}):`, postError);
    await recordPostFailure(deps.db, job, reviewId, postError);
  }

  await deps.db.pullRequestState.upsert({
    where: { repoId_prNumber: { repoId: job.repoId, prNumber: job.prNumber } },
    create: { repoId: job.repoId, prNumber: job.prNumber, headSha: job.headSha },
    update: { headSha: job.headSha }
  });

  return {
    status: "completed",
    reviewId,
    findingCount: persisted.length,
    incremental: onlyPaths !== undefined,
    posted,
    feedbackCollected,
    suppressedByFeedback: applied.suppressed.length,
    memoryCardsUsed: memoryCards.length,
    ...(postError !== undefined ? { postError } : {})
  };
}

async function recordPostFailure(
  db: PrismaClient,
  job: ReviewJob,
  reviewId: string,
  message: string
): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        orgId: job.orgId,
        action: "review.post_failed",
        resource: "review",
        resourceId: reviewId,
        details: JSON.stringify({
          repo: job.repoFullName,
          prNumber: job.prNumber,
          headSha: job.headSha,
          error: message.slice(0, 500)
        })
      }
    });
  } catch (auditError) {
    console.error("Failed to record post failure audit event:", auditError);
  }
}

/**
 * Load the repository's .hubolt.yml from the PR head so hosted reviews honor
 * the same thresholds and ignore rules as local ones. Any failure falls back
 * to defaults rather than failing the job; the config is repo-controlled
 * input and must not be able to break the worker.
 */
async function loadHostedConfig(scm: ScmProvider, headSha: string): Promise<RepoConfig> {
  try {
    const raw = await scm.getFileContent(DEFAULT_CONFIG_FILE, headSha);
    if (raw === null) {
      return RepoConfigSchema.parse({});
    }
    return RepoConfigSchema.parse(parseYaml(raw) ?? {});
  } catch (error) {
    console.warn(
      `Could not load ${DEFAULT_CONFIG_FILE} at ${headSha}; reviewing with defaults:`,
      error instanceof Error ? error.message : error
    );
    return RepoConfigSchema.parse({});
  }
}

async function collectMemoryRuleIds(
  db: PrismaClient,
  job: ReviewJob,
  config: RepoConfig
): Promise<string[]> {
  const ruleIds = new Set(extractExplicitRuleIds(config.rules));

  try {
    const rows = await db.finding.findMany({
      where: {
        orgId: job.orgId,
        repoId: job.repoId
      },
      select: { ruleId: true },
      orderBy: { createdAt: "desc" },
      take: MEMORY_RULE_LOOKBACK_LIMIT
    });

    for (const row of rows) {
      const ruleId = row.ruleId.trim();
      if (ruleId) {
        ruleIds.add(ruleId);
      }
    }
  } catch (error) {
    console.warn(
      `Historical rule lookup failed for PR #${job.prNumber}:`,
      error instanceof Error ? error.message : error
    );
  }

  return [...ruleIds].slice(0, MEMORY_RULE_LOOKBACK_LIMIT);
}

function extractExplicitRuleIds(rules: string[]): string[] {
  const ruleIds = new Set<string>();
  const patterns = [
    /(?:^|\s)(?:ruleId|rule-id|rule|id)\s*[:=]\s*`?([A-Za-z][A-Za-z0-9._\/-]{2,80})`?/i,
    /^\s*\[([A-Za-z][A-Za-z0-9._\/-]{2,80})\]/
  ];

  for (const rule of rules) {
    for (const pattern of patterns) {
      const match = pattern.exec(rule);
      if (match?.[1]) {
        ruleIds.add(match[1]);
        break;
      }
    }
  }

  return [...ruleIds];
}

async function persistReview(
  db: PrismaClient,
  job: ReviewJob,
  findings: Array<{
    fingerprint: string;
    ruleId: string;
    message: string;
    severity: string;
    range: { file: string; startLine: number; endLine: number };
  }>,
  config: RepoConfig
): Promise<string> {
  // One review row per reviewed head: history stays append-only and
  // redeliveries of the same head update rather than duplicate.
  const fingerprint = `pr-${job.prNumber}-${job.headSha}`;

  // Findings are unique per (review, fingerprint); the pipeline dedupes, but
  // the database constraint must never be able to fail the whole persist.
  findings = dedupeFindingsByFingerprint(findings);
  const findingCount = findings.length;

  return await db.$transaction(async (tx) => {
    const review = await tx.review.upsert({
      where: { repoId_fingerprint: { repoId: job.repoId, fingerprint } },
      create: {
        orgId: job.orgId,
        repoId: job.repoId,
        fingerprint,
        scope: "pull-request",
        provider: config.providers.llm,
        model: config.providers.model,
        summary: `PR #${job.prNumber} at ${job.headSha}`,
        findingCount
      },
      update: { orgId: job.orgId, findingCount }
    });

    await tx.finding.deleteMany({ where: { reviewId: review.id } });

    if (findings.length > 0) {
      await tx.finding.createMany({
        data: findings.map((finding) => ({
          orgId: job.orgId,
          repoId: job.repoId,
          reviewId: review.id,
          ruleId: finding.ruleId,
          message: finding.message,
          severity: finding.severity,
          file: finding.range.file,
          lineStart: finding.range.startLine,
          lineEnd: finding.range.endLine,
          fingerprint: finding.fingerprint
        }))
      });
    }

    return review.id;
  });
}

function dedupeFindingsByFingerprint<T extends { fingerprint: string }>(findings: T[]): T[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.fingerprint)) {
      return false;
    }
    seen.add(finding.fingerprint);
    return true;
  });
}
