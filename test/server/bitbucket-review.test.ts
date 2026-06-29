import { afterEach, describe, expect, test, vi } from "vitest";
import { runBitbucketReview } from "../../src/server/services/bitbucket-review.js";
import { processReviewJob } from "../../src/queue/review-processor.js";
import { createHostedReviewLlm } from "../../src/server/services/review-llm.js";

vi.mock("../../src/providers/scm/bitbucket/index.js", () => ({
  BitbucketScmProvider: class {
    async getPullRequest() {
      return {
        headSha: "head_1",
        baseSha: "base_1",
        baseRef: "main"
      };
    }
  }
}));

vi.mock("../../src/queue/review-processor.js", () => ({
  processReviewJob: vi.fn(async (job, deps) => {
    const config = await deps.resolveReviewConfig?.(
      {
        providers: { llm: "openai", model: "gpt-4o-mini" },
        integrations: { slack: { enabled: false }, teams: { enabled: false } }
      },
      job
    );
    await deps.createLlm(config, job);
    return { status: "skipped", reason: "test" };
  })
}));

vi.mock("../../src/server/services/review-llm.js", () => ({
  createHostedReviewLlm: vi.fn().mockResolvedValue({})
}));

const OLD_MASTER = process.env.CREDENTIAL_MASTER_KEY;

describe("runBitbucketReview", () => {
  afterEach(() => {
    vi.clearAllMocks();
    if (OLD_MASTER === undefined) {
      delete process.env.CREDENTIAL_MASTER_KEY;
    } else {
      process.env.CREDENTIAL_MASTER_KEY = OLD_MASTER;
    }
  });

  test("builds the LLM through hosted gateway credential resolution", async () => {
    delete process.env.CREDENTIAL_MASTER_KEY;
    const db: any = {
      organization: {
        findUnique: vi.fn().mockResolvedValue({
          id: "org_1",
          reviewLlmProvider: "anthropic",
          reviewLlmModel: "claude-sonnet"
        })
      }
    };

    await runBitbucketReview(db, {
      orgId: "org_1",
      repoId: "repo_1",
      repoFullName: "ws/repo",
      prNumber: 4,
      action: "manual:test",
      token: "bb-token-12345"
    });

    expect(processReviewJob).toHaveBeenCalled();
    expect(createHostedReviewLlm).toHaveBeenCalledWith(db, "org_1", "anthropic", "claude-sonnet");
  });
});
