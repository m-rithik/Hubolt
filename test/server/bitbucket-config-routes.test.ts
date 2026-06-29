import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { encryptSecret } from "../../src/server/crypto/secret-box.js";
import { registerBitbucketConfigRoutes } from "../../src/server/routes/bitbucket-config.js";
import { runBitbucketReview } from "../../src/server/services/bitbucket-review.js";

vi.mock("../../src/server/services/bitbucket-review.js", () => ({
  runBitbucketReview: vi.fn().mockResolvedValue({ status: "skipped", reason: "test" })
}));

const TOKEN = ["bitbucket", "config", "token"].join("_");
const OLD_MASTER = process.env.CREDENTIAL_MASTER_KEY;

function headers(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

function makeDb(role = "admin") {
  return {
    apiKey: {
      findUnique: vi.fn().mockResolvedValue({
        id: "key_1",
        orgId: "org_1",
        org: { id: "org_1" },
        role,
        expiresAt: null,
        lastUsedAt: new Date()
      }),
      update: vi.fn()
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue({ reviewLlmProvider: null, reviewLlmModel: null }),
      update: vi.fn().mockResolvedValue({})
    },
    providerCredential: {
      findMany: vi.fn().mockResolvedValue([
        { provider: "anthropic", lastUsedAt: null },
        { provider: "bitbucket_threshold", lastUsedAt: null }
      ]),
      findUnique: vi.fn().mockResolvedValue(null)
    },
    repository: {
      findFirst: vi.fn().mockResolvedValue({ id: "repo_1", fullName: "ws/repo" })
    },
    repositoryIntegration: {
      findUnique: vi.fn()
    },
    auditEvent: {
      create: vi.fn().mockResolvedValue({})
    }
  };
}

function buildApp(db: any) {
  const app = Fastify({ logger: false });
  registerBitbucketConfigRoutes(app, { db } as never);
  return app;
}

describe("bitbucket config routes", () => {
  beforeEach(() => {
    process.env.CREDENTIAL_MASTER_KEY = randomBytes(32).toString("base64");
    vi.mocked(runBitbucketReview).mockClear();
  });

  afterEach(() => {
    if (OLD_MASTER === undefined) {
      delete process.env.CREDENTIAL_MASTER_KEY;
    } else {
      process.env.CREDENTIAL_MASTER_KEY = OLD_MASTER;
    }
  });

  test("lists only gateway-backed LLM providers for Bitbucket reviews", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const res = await app.inject({ method: "GET", url: "/bitbucket/config", headers: headers() });

    expect(res.statusCode).toBe(200);
    expect(res.json().providers).toEqual([
      expect.objectContaining({ id: "anthropic", keyPresent: true })
    ]);
    await app.close();
  });

  test("rejects selecting a provider without a gateway credential", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const res = await app.inject({
      method: "PUT",
      url: "/bitbucket/config/model",
      headers: headers(),
      payload: { provider: "openai", model: "gpt-4o-mini" }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("No gateway credential");
    expect(db.organization.update).not.toHaveBeenCalled();
    await app.close();
  });

  test("saves a Bitbucket review model backed by a gateway credential", async () => {
    const db = makeDb();
    db.organization.findUnique.mockResolvedValue({ reviewLlmProvider: "anthropic", reviewLlmModel: "claude-sonnet" });
    const app = buildApp(db);

    const res = await app.inject({
      method: "PUT",
      url: "/bitbucket/config/model",
      headers: headers(),
      payload: { provider: "anthropic", model: "claude-sonnet" }
    });

    expect(res.statusCode).toBe(200);
    expect(db.organization.update).toHaveBeenCalledWith({
      where: { id: "org_1" },
      data: { reviewLlmProvider: "anthropic", reviewLlmModel: "claude-sonnet" }
    });
    await app.close();
  });

  test("admin trigger starts a Bitbucket review from a stored integration", async () => {
    const db = makeDb();
    db.repositoryIntegration.findUnique.mockResolvedValue({
      name: "bb",
      encryptedToken: encryptSecret("bb-token-12345"),
      encryptedWebhookSecret: null,
      encryptedSlackWebhook: null
    });
    const app = buildApp(db);

    const res = await app.inject({
      method: "POST",
      url: "/bitbucket/trigger",
      headers: headers(),
      payload: { repoId: "repo_1", prNumber: 7 }
    });

    expect(res.statusCode).toBe(202);
    expect(runBitbucketReview).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        orgId: "org_1",
        repoId: "repo_1",
        repoFullName: "ws/repo",
        prNumber: 7,
        action: "manual:test-trigger",
        token: "bb-token-12345"
      })
    );
    expect(db.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "bitbucket.review_triggered" }) })
    );
    await app.close();
  });
});
