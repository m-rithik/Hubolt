import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";
import { computeGitHubSignature, verifyGitHubSignature } from "../../src/server/webhooks/signature.js";
import { classifyWebhookEvent } from "../../src/server/webhooks/payload.js";
import { registerWebhookRoutes } from "../../src/server/routes/webhooks.js";
import {
  ReviewJobProducer,
  reviewJobId,
  type ReviewJob,
  type ReviewQueueLike
} from "../../src/queue/review-jobs.js";

const WEBHOOK_SIGNING_KEY = ["fixture", "webhook", "secret"].join("-");

function pullRequestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "opened",
    pull_request: {
      number: 7,
      title: "Add feature",
      draft: false,
      head: { sha: "headsha123", ref: "feature/add" },
      base: { sha: "basesha456", ref: "main" }
    },
    repository: {
      name: "repo",
      full_name: "owner/repo",
      html_url: "https://github.com/owner/repo"
    },
    ...overrides
  };
}

describe("webhook signature", () => {
  test("accepts the signature computed for the exact payload bytes", () => {
    const payload = Buffer.from(JSON.stringify(pullRequestPayload()));
    const signature = computeGitHubSignature(WEBHOOK_SIGNING_KEY, payload);

    expect(verifyGitHubSignature(WEBHOOK_SIGNING_KEY, payload, signature)).toBe(true);
  });

  test("rejects a tampered payload", () => {
    const payload = Buffer.from(JSON.stringify(pullRequestPayload()));
    const signature = computeGitHubSignature(WEBHOOK_SIGNING_KEY, payload);
    const tampered = Buffer.concat([payload, Buffer.from(" ")]);

    expect(verifyGitHubSignature(WEBHOOK_SIGNING_KEY, tampered, signature)).toBe(false);
  });

  test("rejects missing, unprefixed, and wrong-length signatures", () => {
    const payload = Buffer.from("{}");

    expect(verifyGitHubSignature(WEBHOOK_SIGNING_KEY, payload, undefined)).toBe(false);
    expect(verifyGitHubSignature(WEBHOOK_SIGNING_KEY, payload, "sha1=abcdef")).toBe(false);
    expect(verifyGitHubSignature(WEBHOOK_SIGNING_KEY, payload, "sha256=short")).toBe(false);
    expect(verifyGitHubSignature("", payload, computeGitHubSignature(WEBHOOK_SIGNING_KEY, payload))).toBe(false);
  });

  test("rejects a signature made with a different secret", () => {
    const payload = Buffer.from("{}");
    const signature = computeGitHubSignature("other-secret", payload);

    expect(verifyGitHubSignature(WEBHOOK_SIGNING_KEY, payload, signature)).toBe(false);
  });
});

describe("webhook payload classification", () => {
  test("classifies reviewable pull_request actions as review", () => {
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
      const result = classifyWebhookEvent("pull_request", pullRequestPayload({ action }));
      expect(result.kind).toBe("review");
    }
  });

  test("ignores ping, foreign events, irrelevant actions, and drafts", () => {
    expect(classifyWebhookEvent("ping", {}).kind).toBe("ignored");
    expect(classifyWebhookEvent("issues", pullRequestPayload()).kind).toBe("ignored");
    expect(classifyWebhookEvent("pull_request", pullRequestPayload({ action: "closed" })).kind).toBe("ignored");

    const draft = pullRequestPayload();
    (draft.pull_request as Record<string, unknown>).draft = true;
    expect(classifyWebhookEvent("pull_request", draft).kind).toBe("ignored");
  });

  test("flags missing event header and malformed payloads as invalid", () => {
    expect(classifyWebhookEvent(undefined, pullRequestPayload()).kind).toBe("invalid");
    expect(classifyWebhookEvent("pull_request", { action: "opened" }).kind).toBe("invalid");
  });
});

describe("review job producer", () => {
  const job: ReviewJob = {
    orgId: "org_1",
    repoId: "repo_1",
    repoFullName: "owner/repo",
    prNumber: 7,
    headSha: "headsha123",
    baseSha: "basesha456",
    baseRef: "main",
    action: "opened"
  };

  test("derives a stable job id from repo, PR, and head sha", () => {
    expect(reviewJobId(job)).toBe("repo_1:7:headsha123");
  });

  test("enqueues new jobs and dedupes redeliveries", async () => {
    const added: ReviewJob[] = [];
    let stored: { id?: string } | null = null;
    const queue: ReviewQueueLike = {
      getJob: vi.fn(async () => stored),
      add: vi.fn(async (_name, data) => {
        added.push(data);
        stored = { id: reviewJobId(data) };
        return stored;
      }),
      close: vi.fn(async () => undefined)
    };
    const producer = new ReviewJobProducer(queue);

    const first = await producer.enqueue(job);
    expect(first).toEqual({ jobId: "repo_1:7:headsha123", created: true });

    const second = await producer.enqueue(job);
    expect(second).toEqual({ jobId: "repo_1:7:headsha123", created: false });
    expect(added).toHaveLength(1);
  });

  test("treats a duplicate-id add failure as already enqueued", async () => {
    let calls = 0;
    const queue: ReviewQueueLike = {
      getJob: vi.fn(async () => {
        calls += 1;
        return calls > 1 ? { id: "repo_1:7:headsha123" } : null;
      }),
      add: vi.fn(async () => {
        throw new Error("duplicate job id");
      }),
      close: vi.fn(async () => undefined)
    };
    const producer = new ReviewJobProducer(queue);

    await expect(producer.enqueue(job)).resolves.toEqual({
      jobId: "repo_1:7:headsha123",
      created: false
    });
  });
});

describe("webhook route", () => {
  function buildApp(repos: Array<{ id: string; orgId: string }>) {
    const app = Fastify({ logger: false });
    const enqueue = vi.fn(async (job: ReviewJob) => ({ jobId: reviewJobId(job), created: true }));
    const producer = { enqueue, close: vi.fn() } as unknown as ReviewJobProducer;
    const db: any = {
      repository: {
        findMany: vi.fn(async () => repos)
      }
    };

    registerWebhookRoutes(app, { db } as any, { secret: WEBHOOK_SIGNING_KEY, producer });
    return { app, enqueue, db };
  }

  function inject(app: ReturnType<typeof Fastify>, body: Buffer, headers: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: { "content-type": "application/json", ...headers }
    });
  }

  test("rejects deliveries with an invalid signature", async () => {
    const { app, enqueue } = buildApp([{ id: "repo_1", orgId: "org_1" }]);
    const body = Buffer.from(JSON.stringify(pullRequestPayload()));

    const response = await inject(app, body, {
      "x-github-event": "pull_request",
      "x-hub-signature-256": computeGitHubSignature("wrong-secret", body)
    });

    expect(response.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  test("enqueues a review job for a signed pull_request delivery", async () => {
    const { app, enqueue } = buildApp([{ id: "repo_1", orgId: "org_1" }]);
    const body = Buffer.from(JSON.stringify(pullRequestPayload()));

    const response = await inject(app, body, {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": computeGitHubSignature(WEBHOOK_SIGNING_KEY, body)
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ processed: true, queued: true });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        repoId: "repo_1",
        repoFullName: "owner/repo",
        prNumber: 7,
        headSha: "headsha123",
        deliveryId: "delivery-1"
      })
    );
    await app.close();
  });

  test("acknowledges but skips unregistered repositories", async () => {
    const { app, enqueue } = buildApp([]);
    const body = Buffer.from(JSON.stringify(pullRequestPayload()));

    const response = await inject(app, body, {
      "x-github-event": "pull_request",
      "x-hub-signature-256": computeGitHubSignature(WEBHOOK_SIGNING_KEY, body)
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ processed: false });
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  test("acknowledges but skips ambiguous repository registrations", async () => {
    const { app, enqueue } = buildApp([
      { id: "repo_1", orgId: "org_1" },
      { id: "repo_2", orgId: "org_2" }
    ]);
    const body = Buffer.from(JSON.stringify(pullRequestPayload()));

    const response = await inject(app, body, {
      "x-github-event": "pull_request",
      "x-hub-signature-256": computeGitHubSignature(WEBHOOK_SIGNING_KEY, body)
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ processed: false, reason: "repository registration is ambiguous" });
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  test("acknowledges ignored events without touching the database", async () => {
    const { app, enqueue, db } = buildApp([{ id: "repo_1", orgId: "org_1" }]);
    const body = Buffer.from(JSON.stringify({ zen: "Keep it simple." }));

    const response = await inject(app, body, {
      "x-github-event": "ping",
      "x-hub-signature-256": computeGitHubSignature(WEBHOOK_SIGNING_KEY, body)
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ processed: false, reason: "ping event" });
    expect(db.repository.findMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  test("rejects valid-signature deliveries whose payload is not JSON", async () => {
    const { app } = buildApp([{ id: "repo_1", orgId: "org_1" }]);
    const body = Buffer.from("not json");

    const response = await inject(app, body, {
      "x-github-event": "pull_request",
      "x-hub-signature-256": computeGitHubSignature(WEBHOOK_SIGNING_KEY, body)
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
