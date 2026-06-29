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
import { BudgetService } from "../server/services/budget.js";
import { CostEstimator } from "../server/services/cost-estimator.js";
import { buildIntegrations, dispatchIntegrations } from "../integrations/registry.js";
import { buildIntegrationEvent } from "../integrations/event.js";
import { SLACK_WEBHOOK_ENV, TEAMS_WEBHOOK_ENV } from "../integrations/env-names.js";
import { resolveIntegrationByRepoFullName } from "../server/services/repository-integrations.js";
import type { ReviewReport } from "../types/reports.js";
import type { Finding } from "../types/finding.js";

const MEMORY_RULE_LOOKBACK_LIMIT = 50;
const REVIEW_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

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
  /**
   * Finalize the provider/model and any server-side review policy before budget
   * reservation. This keeps spend accounting, report metadata, and the actual LLM
   * call on the same provider/model.
   */
  resolveReviewConfig?: (config: RepoConfig, job: ReviewJob) => RepoConfig | Promise<RepoConfig>;
  /**
   * Environment used to resolve integration webhook secrets (Slack/Teams). When
   * omitted, process.env is used (the common/org-wide webhooks). The Bitbucket
   * path passes a per-repo env so each repo notifies its own Slack webhook.
   */
  integrationEnv?: NodeJS.ProcessEnv;
  /** Override the budget service; defaults to one built from db. Used by tests. */
  budgetService?: BudgetService;
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

  const lockAcquired = await acquireReviewLock(deps.db, job);
  if (!lockAcquired) {
    return { status: "skipped", reason: "head review already in progress" };
  }

  const budgetService = deps.budgetService ?? new BudgetService(deps.db);
  let reservedUsage: { orgId: string; provider: string; model: string; costUsd: number } | null = null;
  try {
    let onlyPaths: Set<string> | undefined;
    if (state && state.headSha !== job.headSha) {
      const changedSince = await scm.compareCommits(state.headSha, job.headSha);
      if (changedSince) {
        onlyPaths = new Set(changedSince);
      }
    }

    // Load review policy from the BASE commit, not the PR head: the head is
    // attacker-controlled, so reading ignore globs / thresholds / rules from it
    // would let a PR suppress its own review (e.g. ignore: ["**/*"]).
    let config = await loadHostedConfig(scm, job.baseSha);
    config = deps.resolveReviewConfig ? await deps.resolveReviewConfig(config, job) : config;

    // Budget gate: if the org configured a monthly budget for this provider and it
    // is already exhausted, skip before fetching files or calling the model. The
    // worker selects providers by config id ("claude"), while budgets key
    // Anthropic as "anthropic"; toGatewayProvider reconciles the two. Best-effort:
    // a budget-system error must not block reviews - fail open on error, closed
    // only on a real overage.
    const budgetProvider = toGatewayProvider(config.providers.llm);
    const costEstimator = new CostEstimator();
    // Reserve the estimated spend ATOMICALLY before the model call. The old
    // check-then-spend (checkBudget with cost 0, then deduct after) let a single
    // review exceed the cap and let concurrent reviews all pass a zero-cost gate.
    // Fail open only on a budget-system error, never on a real overage.
    const estimatedCost = costEstimator.estimateCost(budgetProvider, config.providers.model);
    let reservedCost = 0;
    try {
      const reservation = await budgetService.reserveUsage(
        job.orgId,
        budgetProvider,
        config.providers.model,
        estimatedCost
      );
      if (!reservation.allowed) {
        return { status: "skipped", reason: reservation.reason ?? "monthly budget exhausted" };
      }
      reservedCost = estimatedCost;
      reservedUsage = { orgId: job.orgId, provider: budgetProvider, model: config.providers.model, costUsd: estimatedCost };
    } catch (error) {
      console.warn(
        `Budget reservation failed for PR #${job.prNumber}; proceeding without it:`,
        error instanceof Error ? error.message : error
      );
    }

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

    // Reconcile the reservation against actual usage: charge any overage beyond
    // the reserved estimate, or refund the unused remainder. Best-effort: never
    // fail or re-bill a completed review over bookkeeping.
    try {
      const actualCost = result.usage
        ? costEstimator.calculateActualCost(
            budgetProvider,
            config.providers.model,
            result.usage.inputTokens,
            result.usage.outputTokens
          )
        : reservedCost;
      const delta = actualCost - reservedCost;
      if (delta > 0) {
        await budgetService.deductBudget(job.orgId, budgetProvider, delta);
      } else if (delta < 0) {
        await budgetService.refundUsage(job.orgId, budgetProvider, -delta);
      }
    } catch (error) {
      console.warn(
        `Budget reconciliation failed for PR #${job.prNumber}:`,
        error instanceof Error ? error.message : error
      );
    }
    reservedUsage = null;

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
    await dispatchReviewIntegrations(deps.db, job, config, report, deps.integrationEnv);

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
  } catch (error) {
    if (reservedUsage) {
      await refundReservedUsage(budgetService, reservedUsage, job.prNumber);
    }
    throw error;
  } finally {
    try {
      await releaseReviewLock(deps.db, job);
    } catch (error) {
      console.warn(`Could not release review lock for PR #${job.prNumber}:`, error instanceof Error ? error.message : error);
    }
  }
}

async function acquireReviewLock(db: PrismaClient, job: ReviewJob): Promise<boolean> {
  const lockTable = (db as any).reviewLock;
  if (!lockTable) {
    return true;
  }

  const now = new Date();
  try {
    await lockTable.deleteMany({ where: { expiresAt: { lt: now } } });
    await lockTable.create({
      data: {
        repoId: job.repoId,
        prNumber: job.prNumber,
        headSha: job.headSha,
        expiresAt: new Date(now.getTime() + REVIEW_LOCK_TTL_MS)
      }
    });
    return true;
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return false;
    }
    throw error;
  }
}

async function releaseReviewLock(db: PrismaClient, job: ReviewJob): Promise<void> {
  const lockTable = (db as any).reviewLock;
  if (!lockTable) {
    return;
  }
  await lockTable.deleteMany({
    where: {
      repoId: job.repoId,
      prNumber: job.prNumber,
      headSha: job.headSha
    }
  });
}

async function refundReservedUsage(
  budgetService: BudgetService,
  reserved: { orgId: string; provider: string; model: string; costUsd: number },
  prNumber: number
): Promise<void> {
  try {
    await budgetService.refundUsage(reserved.orgId, reserved.provider, reserved.costUsd);
  } catch (error) {
    console.warn(`Budget refund failed for PR #${prNumber}:`, error instanceof Error ? error.message : error);
  }

  try {
    await budgetService.refundRateLimit(reserved.orgId, reserved.provider, reserved.model);
  } catch (error) {
    console.warn(`Rate-limit refund failed for PR #${prNumber}:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Deliver a completed hosted review to the repo's configured integrations.
 * Best-effort end to end: a setup or delivery failure is logged, never thrown.
 * An audit event records what was delivered (adapters and status only, never
 * the payload or any secret).
 *
 * GitHub reviews intentionally resolve integration destinations from the
 * repository integration table, not the process-wide environment, so one tenant's
 * findings cannot be sent to another tenant's Slack workspace.
 */
async function dispatchReviewIntegrations(
  db: PrismaClient,
  job: ReviewJob,
  config: RepoConfig,
  report: ReviewReport,
  integrationEnv?: NodeJS.ProcessEnv
): Promise<void> {
  let adapters;
  try {
    const env = integrationEnv ?? (await buildRepoIntegrationEnv(db, job));
    adapters = buildIntegrations(config, { env });
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

async function buildRepoIntegrationEnv(db: PrismaClient, job: ReviewJob): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, [SLACK_WEBHOOK_ENV]: "", [TEAMS_WEBHOOK_ENV]: "" };
  try {
    const integration = await resolveIntegrationByRepoFullName(db, job.orgId, job.repoFullName);
    if (integration?.slackWebhookUrl) {
      env[SLACK_WEBHOOK_ENV] = integration.slackWebhookUrl;
    }
  } catch (error) {
    console.warn(
      `Could not resolve repo integration env for PR #${job.prNumber}:`,
      error instanceof Error ? error.message : error
    );
  }
  return env;
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
    confidence?: number;
    confidenceLabel?: string;
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
          fingerprint: finding.fingerprint,
          confidence: findingConfidence(finding)
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

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}

/**
 * Reconcile the worker's provider id with the gateway/budget provider name:
 * the config selects Anthropic as "claude", while budgets, the cost catalog,
 * and gateway usage key it as "anthropic". Other providers share the same id.
 */
function toGatewayProvider(configProvider: string): string {
  return configProvider === "claude" ? "anthropic" : configProvider;
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

function findingConfidence(finding: { confidence?: number; confidenceLabel?: string }): number {
  if (typeof finding.confidence === "number" && Number.isFinite(finding.confidence)) {
    return Math.min(1, Math.max(0, finding.confidence));
  }
  if (finding.confidenceLabel === "high") return 0.9;
  if (finding.confidenceLabel === "medium") return 0.7;
  if (finding.confidenceLabel === "low") return 0.4;
  return 0.5;
}
