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
    // Deliveries now require an installation id; the repo row must already be
    // bound to it (installation events do that, never PR deliveries).
    installation: { id: 4242 },
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
  function buildApp(repos: Array<{ id: string; orgId: string; org?: { slug: string } }>) {
    const app = Fastify({ logger: false });
    const enqueue = vi.fn(async (job: ReviewJob) => ({ jobId: reviewJobId(job), created: true }));
    const producer = { enqueue, close: vi.fn() } as unknown as ReviewJobProducer;
    const db: any = {
      repository: {
        findMany: vi.fn(async () => repos.map((repo) => ({ org: { slug: "owner" }, ...repo }))),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      webhookDelivery: {
        create: vi.fn(async () => ({}))
      }
    };

    registerWebhookRoutes(app, { db } as any, { secrets: [WEBHOOK_SIGNING_KEY], producer });
    return { app, enqueue, db };
  }

  function buildAppWithSecrets(secrets: string[], repos: Array<{ id: string; orgId: string; org?: { slug: string } }>) {
    const app = Fastify({ logger: false });
    const enqueue = vi.fn(async (job: ReviewJob) => ({ jobId: reviewJobId(job), created: true }));
    const producer = { enqueue, close: vi.fn() } as unknown as ReviewJobProducer;
    const db: any = {
      repository: {
        findMany: vi.fn(async () => repos.map((repo) => ({ org: { slug: "owner" }, ...repo }))),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      webhookDelivery: {
        create: vi.fn(async () => ({}))
      }
    };
    registerWebhookRoutes(app, { db } as any, { secrets, producer });
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

  test("accepts a delivery signed with either configured secret", async () => {
    const standalone = "standalone-secret";
    const appSecret = "app-secret";
    const { app, enqueue } = buildAppWithSecrets([standalone, appSecret], [{ id: "repo_1", orgId: "org_1" }]);
    const body = Buffer.from(JSON.stringify(pullRequestPayload()));

    // Signed with the App secret while the standalone secret is also configured;
    // the old single-secret behaviour rejected this with a 401.
    const response = await inject(app, body, {
      "x-github-event": "pull_request",
      "x-hub-signature-256": computeGitHubSignature(appSecret, body)
    });

    expect(response.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalled();
    await app.close();
  });

  test("rejects a delivery signed with none of the configured secrets", async () => {
    const { app, enqueue } = buildAppWithSecrets(["secret-a", "secret-b"], [{ id: "repo_1", orgId: "org_1" }]);
    const body = Buffer.from(JSON.stringify(pullRequestPayload()));

    const response = await inject(app, body, {
      "x-github-event": "pull_request",
      "x-hub-signature-256": computeGitHubSignature("secret-c", body)
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

  test("passes the App installation id to the job and does not mutate the repo from a PR delivery", async () => {
    const { app, enqueue, db } = buildApp([{ id: "repo_1", orgId: "org_1" }]);
    const body = Buffer.from(JSON.stringify(pullRequestPayload({ installation: { id: 4242 } })));

    const response = await inject(app, body, {
      "x-github-event": "pull_request",
      "x-hub-signature-256": computeGitHubSignature(WEBHOOK_SIGNING_KEY, body)
    });

    expect(response.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ installationId: "4242" }));
    // Tenant binding fix: installation ids are never assigned from PR deliveries.
    expect(db.repository.update).not.toHaveBeenCalled();
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

  test("marks repos installed from an installation_repositories event without enqueueing", async () => {
    const { app, enqueue, db } = buildApp([{ id: "repo_1", orgId: "org_1" }]);
    const body = Buffer.from(
      JSON.stringify({
        action: "added",
        installation: { id: 4242, account: { login: "owner" } },
        repositories_added: [{ full_name: "owner/repo" }]
      })
    );

    const response = await inject(app, body, {
      "x-github-event": "installation_repositories",
      "x-github-delivery": "delivery-install-1",
      "x-hub-signature-256": computeGitHubSignature(WEBHOOK_SIGNING_KEY, body)
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ processed: true, reason: "installation updated" });
    expect(db.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { provider: "github", deliveryId: "delivery-install-1", event: "installation_repositories" }
      })
    );
    expect(db.repository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "repo_1" },
        data: { installationId: "4242" }
      })
    );
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  test("does not link an installation when active registrations are ambiguous", async () => {
    const { app, enqueue, db } = buildApp([
      { id: "repo_1", orgId: "org_1" },
      { id: "repo_2", orgId: "org_2" }
    ]);
    const body = Buffer.from(
      JSON.stringify({
        action: "added",
        installation: { id: 4242, account: { login: "owner" } },
        repositories_added: [{ full_name: "owner/repo" }]
      })
    );

    const response = await inject(app, body, {
      "x-github-event": "installation_repositories",
      "x-github-delivery": "delivery-install-ambiguous",
      "x-hub-signature-256": computeGitHubSignature(WEBHOOK_SIGNING_KEY, body)
    });

    expect(response.statusCode).toBe(202);
    expect(db.repository.update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  test("ignores replayed installation deliveries before mutating repositories", async () => {
    const { app, db } = buildApp([{ id: "repo_1", orgId: "org_1" }]);
    db.webhookDelivery.create.mockRejectedValue(Object.assign(new Error("duplicate"), { code: "P2002" }));
    const body = Buffer.from(
      JSON.stringify({
        action: "added",
        installation: { id: 4242, account: { login: "owner" } },
        repositories_added: [{ full_name: "owner/repo" }]
      })
    );

    const response = await inject(app, body, {
      "x-github-event": "installation_repositories",
      "x-github-delivery": "delivery-install-replay",
      "x-hub-signature-256": computeGitHubSignature(WEBHOOK_SIGNING_KEY, body)
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ processed: false, reason: "duplicate delivery" });
    expect(db.repository.update).not.toHaveBeenCalled();
    expect(db.repository.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  test("clears install status when the app is removed from a repo", async () => {
    const { app, db } = buildApp([{ id: "repo_1", orgId: "org_1" }]);
    const body = Buffer.from(
      JSON.stringify({
        action: "removed",
        installation: { id: 4242, account: { login: "owner" } },
        repositories_removed: [{ full_name: "owner/repo" }]
      })
    );

    const response = await inject(app, body, {
      "x-github-event": "installation_repositories",
      "x-github-delivery": "delivery-install-2",
      "x-hub-signature-256": computeGitHubSignature(WEBHOOK_SIGNING_KEY, body)
    });

    expect(response.statusCode).toBe(202);
    expect(db.repository.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fullName: { in: ["owner/repo"] }, installationId: "4242" },
        data: { installationId: null }
      })
    );
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
