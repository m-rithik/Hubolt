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
import { buildIntegrations, dispatchIntegrations } from "../integrations/registry.js";
import { buildIntegrationEvent } from "../integrations/event.js";
import type { ReviewReport } from "../types/reports.js";
import type { Finding } from "../types/finding.js";

const MEMORY_RULE_LOOKBACK_LIMIT = 50;

export interface ReviewProcessorDeps {
  db: PrismaClient;
  /**
   * Build the SCM client for a job. Async because a GitHub App installation
   * token is minted on demand; the env-token path resolves synchronously.
   */
  createScm: (job: ReviewJob) => ScmProvider | Promise<ScmProvider>;
  /**
   * Build the LLM for a job. Receives the job so the worker can resolve the
   * org's gateway-stored credential and provider/model selection.
   */
  createLlm: (config: RepoConfig, job: ReviewJob) => LLMProvider | Promise<LLMProvider>;
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
  const scm = await deps.createScm(job);

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

  const llm = await deps.createLlm(config, job);
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

  // A merge conflict is a deterministic, git-level fact from GitHub's
  // mergeability check, not an LLM judgement. Surface it in the summary and
  // record it like any other finding. `null` means GitHub is still computing
  // mergeability, so only a hard `false` is treated as a conflict.
  if (pr.mergeable === false) {
    applied.summaryOnly = [
      { finding: buildMergeConflictFinding(job, pr.mergeableState), reason: "merge conflict" },
      ...applied.summaryOnly
    ];
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

  // Notify configured integrations after the review is persisted and posted.
  // Best-effort: the LLM has already been paid for, so an integration failure
  // must never fail the job or trigger a re-bill on retry.
  await dispatchReviewIntegrations(deps.db, job, config, report);

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

/**
 * Deliver a completed hosted review to the repo's configured integrations.
 * Best-effort end to end: a setup or delivery failure is logged, never thrown.
 * An audit event records what was delivered (adapters and status only, never
 * the payload or any secret).
 *
 * ponytail: the webhook secret is read from the server environment, so this is
 * correct for a single-tenant/self-hosted server. Per-org integration secrets
 * are the multi-tenant/RBAC slice; until then a multi-tenant operator should
 * leave the global webhook env unset.
 */
async function dispatchReviewIntegrations(
  db: PrismaClient,
  job: ReviewJob,
  config: RepoConfig,
  report: ReviewReport
): Promise<void> {
  let adapters;
  try {
    adapters = buildIntegrations(config);
  } catch (error) {
    console.warn(`Integration setup failed for PR #${job.prNumber}:`, error instanceof Error ? error.message : error);
    return;
  }
  if (adapters.length === 0) {
    return;
  }

  try {
    const results = await dispatchIntegrations(buildIntegrationEvent(report), adapters);

    for (const result of results) {
      if (!result.ok) {
        console.warn(`Integration ${result.adapter} failed for PR #${job.prNumber}: ${result.error ?? "unknown error"}`);
      }
    }

    await db.auditEvent.create({
      data: {
        orgId: job.orgId,
        action: "integration.dispatched",
        resource: "integration",
        details: JSON.stringify({
          prNumber: job.prNumber,
          deliveries: results.map((result) => ({ adapter: result.adapter, ok: result.ok, status: result.status }))
        })
      }
    });
  } catch (error) {
    console.warn(`Integration dispatch failed for PR #${job.prNumber}:`, error instanceof Error ? error.message : error);
  }
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
  let parsedYaml: unknown = {};
  try {
    const raw = await scm.getFileContent(DEFAULT_CONFIG_FILE, headSha);
    if (raw !== null) {
      parsedYaml = parseYaml(raw) ?? {};
    }
  } catch (error) {
    console.warn(
      `Could not load ${DEFAULT_CONFIG_FILE} at ${headSha}; reviewing with defaults:`,
      error instanceof Error ? error.message : error
    );
    parsedYaml = {};
  }

  let config: RepoConfig;
  try {
    config = RepoConfigSchema.parse(parsedYaml);
  } catch (error) {
    console.warn(
      `Invalid ${DEFAULT_CONFIG_FILE} at ${headSha}; reviewing with defaults:`,
      error instanceof Error ? error.message : error
    );
    config = RepoConfigSchema.parse({});
    parsedYaml = {};
  }

  return applyServerProviderDefault(config, parsedYaml);
}

/**
 * When a repository does not pin its LLM provider/model in .hubolt.yml, let the
 * server operator's HUBOLT_LLM_PROVIDER / HUBOLT_LLM_MODEL environment act as
 * the default for hosted reviews. An explicit provider in the repo's config
 * still wins, so per-repo choices are preserved.
 */
export function applyServerProviderDefault(config: RepoConfig, parsedYaml: unknown): RepoConfig {
  const repoProviders = (parsedYaml as { providers?: { llm?: unknown; model?: unknown } } | null | undefined)?.providers;

  if (!repoProviders?.llm && process.env.HUBOLT_LLM_PROVIDER) {
    config.providers.llm = process.env.HUBOLT_LLM_PROVIDER;
  }
  if (!repoProviders?.model && process.env.HUBOLT_LLM_MODEL) {
    config.providers.model = process.env.HUBOLT_LLM_MODEL;
  }
  return config;
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
    category?: string;
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
          category: finding.category ?? null,
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

/**
 * A deterministic finding for a pull request GitHub reports as not mergeable.
 * It is summary-only (never line-mapped) and recorded like any other finding so
 * the conflict shows up in history. The fingerprint is stable per PR so reruns
 * update rather than duplicate it.
 */
function buildMergeConflictFinding(job: ReviewJob, mergeableState?: string): Finding {
  const stateNote = mergeableState ? ` (mergeable_state: ${mergeableState})` : "";
  return {
    fingerprint: `git-merge-conflict-${job.prNumber}`,
    ruleId: "git.merge-conflict",
    title: "Merge conflict with the base branch",
    message:
      `This pull request does not merge cleanly into \`${job.baseRef}\`${stateNote}. ` +
      "Rebase or merge the base branch and resolve the conflicts before merging.",
    category: "bestPractice",
    severity: "high",
    confidenceLabel: "high",
    source: "rule",
    range: { file: job.baseRef, startLine: 1, endLine: 1, diffSide: "right" },
    evidence: ["GitHub reports this pull request as not mergeable."],
    impact: "Merging is blocked until the conflict with the base branch is resolved.",
    verification: "Re-check the pull request's mergeability after resolving the conflicts.",
    relatedSignals: [],
    tags: []
  };
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
