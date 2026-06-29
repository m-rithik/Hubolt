import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { registerBitbucketWebhookRoutes } from "../../src/server/routes/bitbucket-webhooks.js";
import { encryptSecret } from "../../src/server/crypto/secret-box.js";
import { computeGitHubSignature } from "../../src/server/webhooks/signature.js";

beforeAll(() => {
  process.env.CREDENTIAL_MASTER_KEY = randomBytes(32).toString("base64");
});

function prPayload() {
  return {
    pullrequest: {
      id: 5,
      title: "t",
      source: { commit: { hash: "abc" }, branch: { name: "f" } },
      destination: { commit: { hash: "def" }, branch: { name: "main" } }
    },
    repository: { name: "repo", full_name: "ws/repo" }
  };
}

function buildApp(integration: Record<string, unknown> | null) {
  // The webhook resolves the tenant by listing all integrations for the repo
  // full name and verifying the signature against each candidate's secret.
  const rows = integration ? [{ orgId: "org_1", ...integration }] : [];
  const db = {
    repositoryIntegration: { findMany: vi.fn().mockResolvedValue(rows) }
  };
  const app = Fastify({ logger: false });
  registerBitbucketWebhookRoutes(app, { db } as never);
  return app;
}

function inject(app: ReturnType<typeof Fastify>, body: string, sig?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-event-key": "pullrequest:created"
  };
  if (sig) headers["x-hub-signature"] = sig;
  return app.inject({ method: "POST", url: "/webhooks/bitbucket", headers, payload: body });
}

describe("bitbucket webhook authentication", () => {
  const body = JSON.stringify(prPayload());

  test("acknowledges (does not process) a repo with no integration", async () => {
    const res = await inject(buildApp(null), body, "sha256=whatever");
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).processed).toBe(false);
  });

  test("rejects an integration that has no webhook secret (BB-001)", async () => {
    const integration = {
      repoId: "repo_1",
      name: "n",
      encryptedToken: encryptSecret("tok"),
      encryptedWebhookSecret: null,
      encryptedSlackWebhook: null
    };
    const res = await inject(buildApp(integration), body, "sha256=anything");
    expect(res.statusCode).toBe(401);
  });

  test("rejects an invalid signature", async () => {
    const integration = {
      repoId: "repo_1",
      name: "n",
      encryptedToken: encryptSecret("tok"),
      encryptedWebhookSecret: encryptSecret("the-secret"),
      encryptedSlackWebhook: null
    };
    const res = await inject(buildApp(integration), body, "sha256=deadbeef");
    expect(res.statusCode).toBe(401);
  });

  // Multi-org: two orgs registered the same repo slug with different secrets.
  function buildAppRows(rows: Array<Record<string, unknown>>) {
    const db = {
      repositoryIntegration: { findMany: vi.fn().mockResolvedValue(rows) },
      organization: { findUnique: vi.fn().mockResolvedValue(null) }
    };
    const app = Fastify({ logger: false });
    registerBitbucketWebhookRoutes(app, { db } as never);
    return app;
  }

  test("resolves the tenant by the secret that verifies the delivery (Finding #4)", async () => {
    const rows = [
      { orgId: "orgA", repoId: "rA", name: "a", encryptedToken: encryptSecret("tokA"), encryptedWebhookSecret: encryptSecret("secretA"), encryptedSlackWebhook: null },
      { orgId: "orgB", repoId: "rB", name: "b", encryptedToken: encryptSecret("tokB"), encryptedWebhookSecret: encryptSecret("secretB"), encryptedSlackWebhook: null }
    ];
    // Signed with org B's secret => only org B's integration verifies => accepted.
    const sig = computeGitHubSignature("secretB", body);
    const res = await inject(buildAppRows(rows), body, sig);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).processed).toBe(true);
  });

  test("refuses an ambiguous match where two integrations share a secret", async () => {
    const rows = [
      { orgId: "orgA", repoId: "rA", name: "a", encryptedToken: encryptSecret("tokA"), encryptedWebhookSecret: encryptSecret("dup"), encryptedSlackWebhook: null },
      { orgId: "orgB", repoId: "rB", name: "b", encryptedToken: encryptSecret("tokB"), encryptedWebhookSecret: encryptSecret("dup"), encryptedSlackWebhook: null }
    ];
    const sig = computeGitHubSignature("dup", body);
    const res = await inject(buildAppRows(rows), body, sig);
    expect(res.statusCode).toBe(409);
  });
});
