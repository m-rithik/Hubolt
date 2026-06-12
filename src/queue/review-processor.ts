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
  const result = await runReviewPipeline({ context, config, llm });

  const report = buildReport({
    result,
    config,
    scope: context.scope,
    provider: config.providers.llm,
    model: config.providers.model,
    analyzerSignals: []
  });

  const reviewId = await persistReview(deps.db, job, report.findings.length, result.findings, config);

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
      headSha: job.headSha
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
    findingCount: report.findings.length,
    incremental: onlyPaths !== undefined,
    posted,
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

async function persistReview(
  db: PrismaClient,
  job: ReviewJob,
  findingCount: number,
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
  const seen = new Set<string>();
  findings = findings.filter((finding) => {
    if (seen.has(finding.fingerprint)) {
      return false;
    }
    seen.add(finding.fingerprint);
    return true;
  });

  return await db.$transaction(async (tx) => {
    const review = await tx.review.upsert({
      where: { repoId_fingerprint: { repoId: job.repoId, fingerprint } },
      create: {
        repoId: job.repoId,
        fingerprint,
        scope: "pull-request",
        provider: config.providers.llm,
        model: config.providers.model,
        summary: `PR #${job.prNumber} at ${job.headSha}`,
        findingCount
      },
      update: { findingCount }
    });

    await tx.finding.deleteMany({ where: { reviewId: review.id } });

    if (findings.length > 0) {
      await tx.finding.createMany({
        data: findings.map((finding) => ({
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
