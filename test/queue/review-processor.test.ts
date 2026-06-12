import { describe, expect, test, vi } from "vitest";
import { processReviewJob } from "../../src/queue/review-processor.js";
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
  const tx = {
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
      auditEvent: {
        create: vi.fn(async () => undefined)
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
        }
      })
    );
    expect(tx.finding.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            reviewId: "review_1",
            file: "src/a.ts",
            severity: "high"
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
});
