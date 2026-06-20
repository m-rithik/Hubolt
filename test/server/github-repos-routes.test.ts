import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";
import { registerGitHubRepoRoutes, parseRepoInput } from "../../src/server/routes/github-repos.js";

const FIXTURE_TOKEN = ["repos", "route", "token"].join("_");

function bearerHeaders(): Record<string, string> {
  return { authorization: `Bearer ${FIXTURE_TOKEN}` };
}

function makeDb() {
  const db: any = {
    apiKey: {
      findUnique: vi.fn().mockResolvedValue({
        id: "key_1",
        orgId: "org_1",
        org: { id: "org_1" },
        expiresAt: null,
        lastUsedAt: new Date()
      }),
      update: vi.fn()
    },
    repository: {
      findMany: vi.fn().mockResolvedValue([
        {
          fullName: "owner/repo",
          url: "https://github.com/owner/repo",
          installationId: "123",
          createdAt: new Date("2026-01-01T00:00:00.000Z")
        },
        {
          fullName: "owner/pending",
          url: "https://github.com/owner/pending",
          installationId: null,
          createdAt: new Date("2026-01-02T00:00:00.000Z")
        }
      ]),
      upsert: vi.fn().mockResolvedValue({
        id: "repo_1",
        fullName: "owner/repo",
        url: "https://github.com/owner/repo",
        installationId: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      }),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({})
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue({ reviewLlmProvider: null, reviewLlmModel: null }),
      update: vi.fn().mockResolvedValue({})
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) }
  };
  return db;
}

function buildApp(db: any) {
  const app = Fastify({ logger: false });
  registerGitHubRepoRoutes(app, { db });
  return app;
}

describe("github-repos routes", () => {
  test("rejects unauthenticated requests", async () => {
    const app = buildApp(makeDb());
    const response = await app.inject({ method: "GET", url: "/github-repos" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  test("lists repos scoped to the org with install status", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const response = await app.inject({ method: "GET", url: "/github-repos", headers: bearerHeaders() });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(db.repository.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: "org_1", disabledAt: null } })
    );
    expect(body.repos).toEqual([
      expect.objectContaining({ fullName: "owner/repo", installed: true }),
      expect.objectContaining({ fullName: "owner/pending", installed: false })
    ]);
    expect(body).toHaveProperty("appConfigured");
    await app.close();
  });

  test("registers a repo from a pasted URL and writes an audit event", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const response = await app.inject({
      method: "POST",
      url: "/github-repos",
      headers: bearerHeaders(),
      payload: { url: "https://github.com/owner/repo/pull/9" }
    });

    expect(response.statusCode).toBe(201);
    expect(db.repository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId_fullName: { orgId: "org_1", fullName: "owner/repo" } },
        create: expect.objectContaining({ orgId: "org_1", fullName: "owner/repo", url: "https://github.com/owner/repo" })
      })
    );
    expect(db.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "repository.registered" }) })
    );
    await app.close();
  });

  test("rejects a non-github URL with 400", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const response = await app.inject({
      method: "POST",
      url: "/github-repos",
      headers: bearerHeaders(),
      payload: { url: "https://gitlab.com/owner/repo" }
    });

    expect(response.statusCode).toBe(400);
    expect(db.repository.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  test("soft-disables a repo on removal (keeps history), or 404s when missing", async () => {
    const db = makeDb();
    db.repository.findUnique
      .mockResolvedValueOnce({ id: "repo_1", fullName: "owner/repo", disabledAt: null })
      .mockResolvedValueOnce(null);
    const app = buildApp(db);

    const ok = await app.inject({ method: "DELETE", url: "/github-repos/owner/repo", headers: bearerHeaders() });
    expect(ok.statusCode).toBe(200);
    // Soft-disable, not delete: the row (and its reviews) are preserved.
    expect(db.repository.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "repo_1" }, data: expect.objectContaining({ disabledAt: expect.any(Date) }) })
    );
    expect(db.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "repository.unregistered" }) })
    );

    const missing = await app.inject({ method: "DELETE", url: "/github-repos/owner/missing", headers: bearerHeaders() });
    expect(missing.statusCode).toBe(404);

    await app.close();
  });

  test("review-model GET returns current selection and gateway providers", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const response = await app.inject({ method: "GET", url: "/github-repos/review-model", headers: bearerHeaders() });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("provider");
    expect(body).toHaveProperty("model");
    expect(Array.isArray(body.providers)).toBe(true);
    await app.close();
  });

  test("review queue status is null without Redis", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const response = await app.inject({ method: "GET", url: "/github-repos/status", headers: bearerHeaders() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ queue: null });
    await app.close();
  });
});

describe("parseRepoInput", () => {
  test("accepts the common GitHub link forms", () => {
    const expected = { owner: "owner", repo: "repo", fullName: "owner/repo", url: "https://github.com/owner/repo" };
    for (const input of [
      "https://github.com/owner/repo",
      "https://github.com/owner/repo.git",
      "https://github.com/owner/repo/pull/5",
      "http://www.github.com/owner/repo",
      "git@github.com:owner/repo.git",
      "github.com/owner/repo",
      "owner/repo"
    ]) {
      expect(parseRepoInput(input), input).toEqual(expected);
    }
  });

  test("rejects non-github hosts and malformed input", () => {
    for (const input of ["https://gitlab.com/owner/repo", "gitlab.com/owner/repo", "git@gitlab.com:owner/repo.git", "owner", "not a url", ""]) {
      expect(parseRepoInput(input), input).toBeNull();
    }
  });
});
