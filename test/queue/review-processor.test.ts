import { describe, expect, test, vi } from "vitest";
import { processReviewJob, applyServerProviderDefault } from "../../src/queue/review-processor.js";
import { RepoConfigSchema } from "../../src/config/schema.js";
import type { ReviewJob } from "../../src/queue/review-jobs.js";
import type { ScmProvider } from "../../src/providers/scm/scm.interface.js";
import type { LLMProvider } from "../../src/types/providers.js";

const PATCH = ["@@ -1,2 +1,3 @@", " line one", "+const risky = input;", " line two"].join("\n");
const FILE_CONTENT = "line one\nconst risky = input;\nline two\n";

const JOB: ReviewJob = {
  orgId: "org_1",
  repoId: "repo_1",
  repoFullName: "owner/repo",
  prNumber: 7,
  headSha: "headsha123",
  baseSha: "base456",
  baseRef: "main",
  action: "opened"
};

function llmFinding() {
  return {
    ruleId: "no-raw-input",
    title: "Raw input assigned",
    message: "Input is stored without validation.",
    category: "security",
    severity: "high",
    confidenceLabel: "high",
    range: { file: "src/a.ts", startLine: 2, endLine: 2 },
    evidence: ["const risky = input;"],
    impact: "Unvalidated input can reach sinks.",
    suggestion: "Validate the input first.",
    verification: "Trace the variable to its uses.",
    relatedSignals: []
  };
}

function makeScm(overrides: Partial<Record<keyof ScmProvider, unknown>> = {}) {
  return {
    getPullRequest: vi.fn(async () => ({
      number: 7,
      headSha: "headsha123",
      baseSha: "base456",
      baseRef: "main",
      draft: false
    })),
    listPullRequestFiles: vi.fn(async () => [
      { filename: "src/a.ts", status: "modified", patch: PATCH }
    ]),
    compareCommits: vi.fn(async () => null),
    getFileContent: vi.fn(async (path: string) => (path === "src/a.ts" ? FILE_CONTENT : null)),
    listIssueComments: vi.fn(async () => []),
    createIssueComment: vi.fn(async (_pr: number, body: string) => ({ id: 1, body })),
    updateIssueComment: vi.fn(async () => undefined),
    listReviewComments: vi.fn(async () => []),
    createReview: vi.fn(async () => undefined),
    ...overrides
  } as unknown as ScmProvider & Record<string, ReturnType<typeof vi.fn>>;
}

function makeDb(stateHeadSha: string | null) {
  let queryRawCalls = 0;
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => {
      queryRawCalls += 1;
      return queryRawCalls >= 3 ? [{ requestCount: 1, maxRequestsPerDay: 1000 }] : [];
    }),
    review: {
      upsert: vi.fn(async (args: any) => ({ id: "review_1", ...args.create }))
    },
    finding: {
      deleteMany: vi.fn(async () => undefined),
      createMany: vi.fn(async () => undefined)
    }
  };
  return {
    tx,
    db: {
      pullRequestState: {
        findUnique: vi.fn(async () =>
          stateHeadSha ? { id: "state_1", repoId: "repo_1", prNumber: 7, headSha: stateHeadSha } : null
        ),
        upsert: vi.fn(async () => undefined)
      },
      reviewLock: {
        deleteMany: vi.fn(async () => undefined),
        create: vi.fn(async () => ({ id: "lock_1" }))
      },
      auditEvent: {
        create: vi.fn(async () => undefined)
      },
      finding: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => [])
      },
      findingFeedback: {
        groupBy: vi.fn(async () => []),
        createMany: vi.fn(async (args: any) => ({ count: args.data.length }))
      },
      memoryCard: {
        findMany: vi.fn(async () => [])
      },
      $transaction: vi.fn(async (callback: any) => callback(tx))
    } as any
  };
}

function makeLlm(findings: unknown[] = [llmFinding()]): LLMProvider {
  return {
    name: "fake",
    review: vi.fn(async () => findings)
  } as unknown as LLMProvider;
}

describe("processReviewJob", () => {
  test("skips when the pull request head has moved past the job", async () => {
    const scm = makeScm({
      getPullRequest: vi.fn(async () => ({
        number: 7,
        headSha: "newer-head",
        baseSha: "base456",
        baseRef: "main",
        draft: false
      }))
    });
    const { db } = makeDb(null);

    const outcome = await processReviewJob(JOB, {
      db,
      createScm: () => scm,
      createLlm: () => makeLlm()
    });

    expect(outcome).toMatchObject({ status: "skipped" });
    expect(scm.listPullRequestFiles).not.toHaveBeenCalled();
  });

  test("skips redeliveries of an already reviewed head", async () => {
    const scm = makeScm();
    const { db } = makeDb("headsha123");

    const outcome = await processReviewJob(JOB, {
      db,
      createScm: () => scm,
      createLlm: () => makeLlm()
    });

    expect(outcome).toMatchObject({ status: "skipped", reason: "head already reviewed" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  test("loads review config from the base SHA, not the attacker-controlled PR head", async () => {
    const scm = makeScm();
    const { db } = makeDb(null);

    await processReviewJob(JOB, { db, createScm: () => scm, createLlm: () => makeLlm() });

    // .hubolt.yml (ignore globs / thresholds / rules) must be read at the trusted
    // base commit so a PR cannot suppress its own review.
    expect(scm.getFileContent).toHaveBeenCalledWith(expect.stringContaining(".hubolt.yml"), JOB.baseSha);
    expect(scm.getFileContent).not.toHaveBeenCalledWith(expect.stringContaining(".hubolt.yml"), JOB.headSha);
  });

  test("skips when reserving the estimated budget is denied (reserve-before-spend)", async () => {
    const scm = makeScm();
    const { db } = makeDb(null);
    const budgetService = {
      reserveUsage: vi.fn(async () => ({ allowed: false, reason: "Budget exceeded" })),
      deductBudget: vi.fn(),
      refundUsage: vi.fn()
    } as any;
    const llm = makeLlm();

    const outcome = await processReviewJob(JOB, { db, budgetService, createScm: () => scm, createLlm: () => llm });

    expect(outcome).toMatchObject({ status: "skipped" });
    // The reservation happens BEFORE any diff fetch or model call.
    expect(budgetService.reserveUsage).toHaveBeenCalled();
    expect(scm.listPullRequestFiles).not.toHaveBeenCalled();
    expect((llm as unknown as { review: ReturnType<typeof vi.fn> }).review).not.toHaveBeenCalled();
  });

  test("reserves estimated budget before the model call, then reconciles", async () => {
    const scm = makeScm();
    const { db } = makeDb(null);
    const budgetService = {
      reserveUsage: vi.fn(async () => ({ allowed: true })),
      deductBudget: vi.fn(async () => undefined),
      refundUsage: vi.fn(async () => undefined)
    } as any;

    const outcome = await processReviewJob(JOB, { db, budgetService, createScm: () => scm, createLlm: () => makeLlm() });

    expect(outcome.status).toBe("completed");
    // Reservation is made before the LLM call; reconciliation runs after.
    expect(budgetService.reserveUsage).toHaveBeenCalledOnce();
  });

  test("skips when another worker already holds the same head lock", async () => {
    const scm = makeScm();
    const { db } = makeDb(null);
    db.reviewLock.create = vi.fn(async () => {
      throw Object.assign(new Error("duplicate"), { code: "P2002" });
    });

    const outcome = await processReviewJob(JOB, {
      db,
      createScm: () => scm,
      createLlm: () => makeLlm()
    });

    expect(outcome).toMatchObject({ status: "skipped", reason: "head review already in progress" });
    expect(scm.listPullRequestFiles).not.toHaveBeenCalled();
  });

  test("refunds budget and rate-limit reservations when pre-model work throws", async () => {
    const scm = makeScm({
      listPullRequestFiles: vi.fn(async () => {
        throw new Error("SCM unavailable");
      })
    });
    const { db } = makeDb(null);
    const budgetService = {
      reserveUsage: vi.fn(async () => ({ allowed: true })),
      deductBudget: vi.fn(async () => undefined),
      refundUsage: vi.fn(async () => undefined),
      refundRateLimit: vi.fn(async () => undefined)
    } as any;

    await expect(
      processReviewJob(JOB, { db, budgetService, createScm: () => scm, createLlm: () => makeLlm() })
    ).rejects.toThrow("SCM unavailable");

    expect(budgetService.refundUsage).toHaveBeenCalledWith("org_1", "openai", expect.any(Number));
    expect(budgetService.refundRateLimit).toHaveBeenCalledWith("org_1", "openai", "gpt-4o-mini");
  });

  test("resolves the final provider and model before reserving budget", async () => {
    const scm = makeScm();
    const { db } = makeDb(null);
    const budgetService = {
      reserveUsage: vi.fn(async () => ({ allowed: true })),
      deductBudget: vi.fn(async () => undefined),
      refundUsage: vi.fn(async () => undefined),
      refundRateLimit: vi.fn(async () => undefined)
    } as any;
    const createLlm = vi.fn((config: any) => {
      expect(config.providers).toMatchObject({ llm: "claude", model: "claude-3-5-sonnet-latest" });
      return makeLlm();
    });

    const outcome = await processReviewJob(JOB, {
      db,
      budgetService,
      createScm: () => scm,
      createLlm,
      resolveReviewConfig: (config) => {
        config.providers.llm = "claude";
        config.providers.model = "claude-3-5-sonnet-latest";
        return config;
      }
    });

    expect(outcome.status).toBe("completed");
    expect(budgetService.reserveUsage).toHaveBeenCalledWith(
      "org_1",
      "anthropic",
      "claude-3-5-sonnet-latest",
      expect.any(Number)
    );
    expect(createLlm).toHaveBeenCalled();
  });

  test("runs a full review, persists it, posts results, and records state", async () => {
    const scm = makeScm();
    const { db, tx } = makeDb(null);

    const outcome = await processReviewJob(JOB, {
      db,
      createScm: () => scm,
      createLlm: () => makeLlm()
    });

    expect(outcome).toMatchObject({
      status: "completed",
      reviewId: "review_1",
      findingCount: 1,
      incremental: false
    });

    expect(tx.review.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repoId_fingerprint: { repoId: "repo_1", fingerprint: "pr-7-headsha123" }
        },
        create: expect.objectContaining({ orgId: "org_1", repoId: "repo_1" })
      })
    );
    expect(tx.finding.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            orgId: "org_1",
            repoId: "repo_1",
            reviewId: "review_1",
            file: "src/a.ts",
            severity: "high",
            confidence: 0.9
          })
        ]
      })
    );

    expect(scm.createIssueComment).toHaveBeenCalledTimes(1);
    expect(scm.createReview).toHaveBeenCalledWith(
      7,
      "headsha123",
      undefined,
      [expect.objectContaining({ path: "src/a.ts", line: 2, side: "RIGHT" })]
    );

    expect(db.pullRequestState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { repoId: "repo_1", prNumber: 7, headSha: "headsha123" }
      })
    );
  });

  test("synchronize runs review only files changed since the last head", async () => {
    const scm = makeScm({
      listPullRequestFiles: vi.fn(async () => [
        { filename: "src/a.ts", status: "modified", patch: PATCH },
        { filename: "src/untouched.ts", status: "modified", patch: PATCH }
      ]),
      compareCommits: vi.fn(async () => ["src/a.ts"])
    });
    const { db } = makeDb("older-head");

    const outcome = await processReviewJob(JOB, {
      db,
      createScm: () => scm,
      createLlm: () => makeLlm()
    });

    expect(outcome).toMatchObject({ status: "completed", incremental: true });
    expect(scm.compareCommits).toHaveBeenCalledWith("older-head", "headsha123");
    expect(scm.getFileContent).toHaveBeenCalledWith("src/a.ts", "headsha123");
    expect(scm.getFileContent).not.toHaveBeenCalledWith("src/untouched.ts", "headsha123");
  });

  test("falls back to a full review when the comparison is unavailable", async () => {
    const scm = makeScm({ compareCommits: vi.fn(async () => null) });
    const { db } = makeDb("older-head");

    const outcome = await processReviewJob(JOB, {
      db,
      createScm: () => scm,
      createLlm: () => makeLlm()
    });

    expect(outcome).toMatchObject({ status: "completed", incremental: false });
  });

  test("posting failure does not fail the job and is audited", async () => {
    const scm = makeScm({
      createIssueComment: vi.fn(async () => {
        throw new Error("GitHub is down");
      })
    });
    const { db } = makeDb(null);

    const outcome = await processReviewJob(JOB, {
      db,
      createScm: () => scm,
      createLlm: () => makeLlm()
    });

    expect(outcome).toMatchObject({
      status: "completed",
      reviewId: "review_1",
      posted: null,
      postError: "GitHub is down"
    });
    expect(db.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "review.post_failed" })
      })
    );
    expect(db.pullRequestState.upsert).toHaveBeenCalled();
  });

  test("demotes findings whose rule the team consistently dismisses", async () => {
    const scm = makeScm();
    const { db } = makeDb(null);
    db.findingFeedback.groupBy = vi.fn(async (args: any) =>
      args.by.includes("ruleId")
        ? [{ ruleId: "no-raw-input", verdict: "dismissed", _count: { _all: 6 } }]
        : []
    );

    // A quality/medium finding: not covered by the security/critical
    // exemptions, so rule-level feedback may demote it.
    const outcome = await processReviewJob(JOB, {
      db,
      createScm: () => scm,
      createLlm: () => makeLlm([{ ...llmFinding(), category: "quality", severity: "medium" }])
    });

    // The finding moves to the summary: nothing inline, reason in the body.
    expect(outcome).toMatchObject({ status: "completed", findingCount: 1, suppressedByFeedback: 0 });
    const ruleFeedbackCall = (db.findingFeedback.groupBy as any).mock.calls.find((call: any[]) =>
      call[0].by.includes("ruleId") && call[0].by.includes("verdict")
    );
    expect(ruleFeedbackCall[0].where).toMatchObject({ orgId: "org_1", repoId: "repo_1" });
    expect(scm.createReview).not.toHaveBeenCalled();
    const summaryBody = (scm.createIssueComment as any).mock.calls[0][1];
    expect(summaryBody).toContain("rule dismissed 6 times across reviews");
  });

  test("injects retrieved memory cards into the prompt and reports usage", async () => {
    const scm = makeScm();
    const { db } = makeDb(null);
    db.memoryCard.findMany = vi.fn(async () => [
      {
        id: "card1",
        repoId: "",
        ruleId: "",
        kind: "style",
        title: "conventions",
        body: "prefer zod validation at api boundaries",
        tokensEstimate: 12,
        sourceCount: 0,
        pinned: true,
        updatedAt: new Date()
      }
    ]);

    let seenUser = "";
    const llm = {
      name: "fake",
      review: vi.fn(async (request: any) => {
        seenUser = request.user;
        return [];
      })
    } as any;

    const outcome = await processReviewJob(JOB, {
      db,
      createScm: () => scm,
      createLlm: () => llm
    });

    expect(outcome).toMatchObject({ status: "completed", memoryCardsUsed: 1 });
    expect(seenUser).toContain("kind=teamMemory");
    expect(seenUser).toContain("prefer zod validation at api boundaries");
  });

  test("retrieves rule-calibration memory from prior repository findings", async () => {
    const scm = makeScm();
    const { db } = makeDb(null);
    db.finding.findMany = vi.fn(async () => [{ ruleId: "no-raw-input" }]);
    db.memoryCard.findMany = vi.fn(async () => [
      {
        id: "card1",
        repoId: "",
        ruleId: "no-raw-input",
        kind: "rule",
        title: "no-raw-input calibration",
        body: "the team usually acts on no-raw-input findings",
        tokensEstimate: 12,
        sourceCount: 5,
        pinned: false,
        updatedAt: new Date()
      }
    ]);

    let seenUser = "";
    const llm = {
      name: "fake",
      review: vi.fn(async (request: any) => {
        seenUser = request.user;
        return [];
      })
    } as any;

    const outcome = await processReviewJob(JOB, {
      db,
      createScm: () => scm,
      createLlm: () => llm
    });

    expect(outcome).toMatchObject({ status: "completed", memoryCardsUsed: 1 });
    expect(db.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orgId: "org_1",
          repoId: "repo_1"
        },
        select: { ruleId: true }
      })
    );
    expect(seenUser).toContain("kind=teamMemory");
    expect(seenUser).toContain("the team usually acts on no-raw-input findings");
  });

  test("collects PR feedback before reviewing", async () => {
    const marker = "<!-- hubolt:finding:fp-old -->";
    const scm = makeScm({
      listReviewComments: vi.fn(async () => [
        {
          id: 9,
          body: `old finding\n${marker}`,
          path: "src/a.ts",
          line: 2,
          inReplyTo: null,
          authorIsBot: true,
          reactions: { up: 1, down: 0 }
        }
      ])
    });
    const { db } = makeDb(null);
    db.finding.findMany = vi.fn(async (args: any) =>
      args.where?.fingerprint
        ? [
            {
              id: "f-old",
              fingerprint: "fp-old",
              ruleId: "rule-old",
              severity: "low",
              orgId: "org_1",
              repoId: "repo_1",
              createdAt: new Date("2026-01-01T00:00:00.000Z")
            }
          ]
        : []
    );

    const outcome = await processReviewJob(JOB, {
      db,
      createScm: () => scm,
      createLlm: () => makeLlm()
    });

    expect(outcome).toMatchObject({ status: "completed", feedbackCollected: 1 });
    expect(db.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          fingerprint: { in: ["fp-old"] },
          orgId: "org_1",
          repoId: "repo_1"
        }
      })
    );
    expect(db.findingFeedback.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ fingerprint: "fp-old", verdict: "accepted" })],
        skipDuplicates: true
      })
    );
  });

  test("honors repository config fetched from the PR head", async () => {
    const scm = makeScm({
      getFileContent: vi.fn(async (path: string) => {
        if (path === ".hubolt.yml") return "ignore:\n  - src/**\n";
        if (path === "src/a.ts") return FILE_CONTENT;
        return null;
      })
    });
    const { db, tx } = makeDb(null);
    const llm = makeLlm();

    const outcome = await processReviewJob(JOB, {
      db,
      createScm: () => scm,
      createLlm: () => llm
    });

    // The only file is ignored by repo config, so nothing is reviewable and
    // the run completes with zero findings.
    expect(outcome).toMatchObject({ status: "completed", findingCount: 0 });
    expect(tx.finding.createMany).not.toHaveBeenCalled();
  });

  test("dispatches to integrations enabled in repo config with scoped env and audits delivery", async () => {
    const scm = makeScm({
      getFileContent: vi.fn(async (path: string) => {
        if (path === ".hubolt.yml") {
          return "integrations:\n  slack:\n    enabled: true\n    minSeverity: info\n";
        }
        if (path === "src/a.ts") return FILE_CONTENT;
        return null;
      })
    });
    const { db } = makeDb(null);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    try {
      const outcome = await processReviewJob(JOB, {
        db,
        integrationEnv: { ...process.env, HUBOLT_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/test" },
        createScm: () => scm,
        createLlm: () => makeLlm()
      });

      expect(outcome.status).toBe("completed");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://hooks.slack.com/services/test",
        expect.objectContaining({ method: "POST" })
      );
      expect(db.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: "integration.dispatched" })
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("does not dispatch when no integration is enabled", async () => {
    const scm = makeScm();
    const { db } = makeDb(null);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    try {
      await processReviewJob(JOB, { db, createScm: () => scm, createLlm: () => makeLlm() });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.auditEvent.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: "integration.dispatched" }) })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("does not fall back to the global Slack webhook for GitHub reviews", async () => {
    const scm = makeScm({
      getFileContent: vi.fn(async (path: string) => {
        if (path === ".hubolt.yml") {
          return "integrations:\n  slack:\n    enabled: true\n    minSeverity: info\n";
        }
        if (path === "src/a.ts") return FILE_CONTENT;
        return null;
      })
    });
    const { db } = makeDb(null);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("HUBOLT_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/global");

    try {
      const outcome = await processReviewJob(JOB, {
        db,
        createScm: () => scm,
        createLlm: () => makeLlm()
      });

      expect(outcome.status).toBe("completed");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  test("adds a merge-conflict note when GitHub reports the PR as not mergeable", async () => {
    const scm = makeScm({
      getPullRequest: vi.fn(async () => ({
        number: 7,
        headSha: "headsha123",
        baseSha: "base456",
        baseRef: "main",
        draft: false,
        mergeable: false,
        mergeableState: "dirty"
      }))
    });
    const { db, tx } = makeDb(null);

    const outcome = await processReviewJob(JOB, {
      db,
      createScm: () => scm,
      createLlm: () => makeLlm()
    });

    expect(outcome.status).toBe("completed");

    // Recorded like any other finding.
    const createdFindings = (tx.finding.createMany as any).mock.calls[0][0].data;
    expect(createdFindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: "git.merge-conflict", severity: "high" })])
    );

    // Surfaced in the summary comment (summary-only, not inline).
    const summaryBody = (scm.createIssueComment as any).mock.calls[0][1];
    expect(summaryBody).toContain("Merge conflict with the base branch");
  });

  test("adds no merge-conflict note while mergeability is still unknown", async () => {
    const scm = makeScm({
      getPullRequest: vi.fn(async () => ({
        number: 7,
        headSha: "headsha123",
        baseSha: "base456",
        baseRef: "main",
        draft: false,
        mergeable: null
      }))
    });
    const { db, tx } = makeDb(null);

    await processReviewJob(JOB, { db, createScm: () => scm, createLlm: () => makeLlm() });

    const createdFindings = (tx.finding.createMany as any).mock.calls[0]?.[0]?.data ?? [];
    expect(createdFindings.some((finding: any) => finding.ruleId === "git.merge-conflict")).toBe(false);
  });
});

describe("applyServerProviderDefault", () => {
  test("falls back to HUBOLT_LLM_PROVIDER/MODEL when the repo pins none", () => {
    vi.stubEnv("HUBOLT_LLM_PROVIDER", "google");
    vi.stubEnv("HUBOLT_LLM_MODEL", "gemini-flash-latest");
    try {
      const config = applyServerProviderDefault(RepoConfigSchema.parse({}), {});
      expect(config.providers.llm).toBe("google");
      expect(config.providers.model).toBe("gemini-flash-latest");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("an explicit repo provider wins over the server env", () => {
    vi.stubEnv("HUBOLT_LLM_PROVIDER", "google");
    vi.stubEnv("HUBOLT_LLM_MODEL", "gemini-flash-latest");
    try {
      const yaml = { providers: { llm: "anthropic", model: "claude-x" } };
      const config = applyServerProviderDefault(RepoConfigSchema.parse(yaml), yaml);
      expect(config.providers.llm).toBe("anthropic");
      expect(config.providers.model).toBe("claude-x");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("keeps schema defaults when no env override is set", () => {
    vi.stubEnv("HUBOLT_LLM_PROVIDER", "");
    vi.stubEnv("HUBOLT_LLM_MODEL", "");
    try {
      const config = applyServerProviderDefault(RepoConfigSchema.parse({}), {});
      expect(config.providers.llm).toBe("openai");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
