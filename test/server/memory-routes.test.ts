import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";
import { registerMemoryRoutes } from "../../src/server/routes/memory.js";

const FIXTURE_TOKEN = ["memory", "route", "token"].join("_");

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
    memoryCard: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "card_1",
          repoId: "repo_1",
          ruleId: "style",
          kind: "style",
          title: "Style",
          body: "Prefer small modules.",
          tokensEstimate: 4,
          sourceCount: 0,
          pinned: true,
          updatedAt: new Date("2026-01-01T00:00:00.000Z")
        }
      ]),
      createMany: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      groupBy: vi.fn(),
      delete: vi.fn(),
      count: vi.fn()
    },
    findingFeedback: {
      groupBy: vi.fn()
    }
  };
  db.$transaction = vi.fn(async (callback: any) => callback(db));
  return db;
}

describe("memory routes", () => {
  test("lists cards scoped to the authenticated org and optional repo", async () => {
    const app = Fastify({ logger: false });
    const db = makeDb();
    registerMemoryRoutes(app, { db });

    const response = await app.inject({
      method: "GET",
      url: "/memory/cards?repo=repo_1",
      headers: bearerHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().cards).toHaveLength(1);
    expect(db.memoryCard.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: "org_1", repoId: { in: ["", "repo_1"] } }
      })
    );

    await app.close();
  });

  test("rejects malformed list query parameters", async () => {
    const app = Fastify({ logger: false });
    const db = makeDb();
    registerMemoryRoutes(app, { db });

    const response = await app.inject({
      method: "GET",
      url: "/memory/cards?repo=",
      headers: bearerHeaders()
    });

    expect(response.statusCode).toBe(400);
    expect(db.memoryCard.findMany).not.toHaveBeenCalled();

    await app.close();
  });

  test("rejects malformed style-card payloads", async () => {
    const app = Fastify({ logger: false });
    const db = makeDb();
    registerMemoryRoutes(app, { db });

    const response = await app.inject({
      method: "POST",
      url: "/memory/cards",
      headers: bearerHeaders(),
      payload: { title: "", body: "body" }
    });

    expect(response.statusCode).toBe(400);
    expect(db.memoryCard.upsert).not.toHaveBeenCalled();

    await app.close();
  });

  test("rebuild removes stale rule cards with one batch delete", async () => {
    const app = Fastify({ logger: false });
    const db = makeDb();
    db.findingFeedback.groupBy = vi.fn(async () => [
      { repoId: "repo_1", ruleId: "kept-rule", verdict: "accepted", _count: { _all: 3 } }
    ]);
    db.memoryCard.findMany = vi.fn(async () => [
      {
        id: "stale_1",
        repoId: "repo_1",
        ruleId: "stale-a",
        kind: "rule",
        title: "Stale A",
        body: "",
        tokensEstimate: 1,
        sourceCount: 1,
        pinned: false,
        updatedAt: new Date()
      },
      {
        id: "stale_2",
        repoId: "repo_1",
        ruleId: "stale-b",
        kind: "rule",
        title: "Stale B",
        body: "",
        tokensEstimate: 1,
        sourceCount: 1,
        pinned: false,
        updatedAt: new Date()
      }
    ]);
    db.memoryCard.upsert = vi.fn(async () => undefined);
    db.memoryCard.createMany = vi.fn(async () => ({ count: 1 }));
    db.memoryCard.update = vi.fn(async () => undefined);
    db.memoryCard.deleteMany = vi.fn(async () => ({ count: 2 }));
    db.memoryCard.delete = vi.fn(async () => undefined);
    db.memoryCard.count = vi.fn(async () => 0);
    registerMemoryRoutes(app, { db });

    const response = await app.inject({
      method: "POST",
      url: "/memory/rebuild",
      headers: bearerHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ removedStale: 2 });
    expect(db.memoryCard.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.memoryCard.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["stale_1", "stale_2"] } }
    });
    expect(db.memoryCard.upsert).not.toHaveBeenCalled();
    expect(db.memoryCard.delete).not.toHaveBeenCalled();

    await app.close();
  });

  test("rebuild batches new rule cards and updates existing cards inside one transaction", async () => {
    const app = Fastify({ logger: false });
    const db = makeDb();
    db.findingFeedback.groupBy = vi.fn(async () => [
      { repoId: "repo_1", ruleId: "existing-rule", verdict: "accepted", _count: { _all: 3 } },
      { repoId: "repo_1", ruleId: "new-rule", verdict: "dismissed", _count: { _all: 3 } }
    ]);
    db.memoryCard.findMany = vi.fn(async () => [
      {
        id: "card_existing",
        repoId: "repo_1",
        ruleId: "existing-rule",
        kind: "rule",
        title: "Old",
        body: "Old body",
        tokensEstimate: 1,
        sourceCount: 1,
        pinned: false,
        updatedAt: new Date()
      }
    ]);
    db.memoryCard.createMany = vi.fn(async () => ({ count: 1 }));
    db.memoryCard.update = vi.fn(async () => undefined);
    db.memoryCard.deleteMany = vi.fn(async () => ({ count: 0 }));
    db.memoryCard.count = vi.fn(async () => 0);
    registerMemoryRoutes(app, { db });

    const response = await app.inject({
      method: "POST",
      url: "/memory/rebuild",
      headers: bearerHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ruleCards: 2, removedStale: 0 });
    expect(db.memoryCard.findMany).toHaveBeenCalledWith({
      where: { orgId: "org_1", kind: "rule" }
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.memoryCard.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            orgId: "org_1",
            repoId: "repo_1",
            kind: "rule",
            ruleId: "new-rule"
          })
        ],
        skipDuplicates: true
      })
    );
    expect(db.memoryCard.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orgId_repoId_kind_ruleId: {
            orgId: "org_1",
            repoId: "repo_1",
            kind: "rule",
            ruleId: "existing-rule"
          }
        }
      })
    );
    expect(db.memoryCard.upsert).not.toHaveBeenCalled();

    await app.close();
  });
});
