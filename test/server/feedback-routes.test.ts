import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";
import { registerFeedbackRoutes } from "../../src/server/routes/feedback.js";

const FIXTURE_TOKEN = ["feedback", "route", "token"].join("_");

function bearerHeaders(): Record<string, string> {
  return { authorization: `Bearer ${FIXTURE_TOKEN}` };
}

function makeDb(findingExists: boolean) {
  const created: any[] = [];
  let externalIds = new Set<string>();
  return {
    created,
    db: {
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
      finding: {
        findMany: vi.fn(async () =>
          findingExists
            ? [
                {
                  id: "f1",
                  fingerprint: "fp-1",
                  ruleId: "rule-1",
                  severity: "high",
                  orgId: "org_1",
                  repoId: "repo_1",
                  createdAt: new Date("2026-01-01T00:00:00.000Z")
                }
              ]
            : []
        )
      },
      repository: {
        findFirst: vi.fn(async () => ({ id: "repo_1" }))
      },
      findingFeedback: {
        createMany: vi.fn(async (args: any) => {
          let count = 0;
          for (const row of args.data) {
            const externalId = row.externalId;
            if (externalId && externalIds.has(externalId)) {
              continue;
            }
            if (externalId) externalIds.add(externalId);
            created.push(row);
            count += 1;
          }
          return { count };
        })
      },
      auditEvent: { create: vi.fn(async () => undefined) }
    } as any
  };
}

describe("POST /feedback", () => {
  test("stores events, attributes them to stored findings, and dedupes re-imports", async () => {
    const app = Fastify({ logger: false });
    const { db, created } = makeDb(true);
    registerFeedbackRoutes(app, { db } as any);

    const payload = {
      repo: "owner/repo",
      events: [
        { fingerprint: "fp-1", verdict: "accepted", source: "github-reaction", externalId: "gh:rc:1:+1" },
        { fingerprint: "fp-1", verdict: "accepted", source: "github-reaction", externalId: "gh:rc:1:+1" }
      ]
    };

    const response = await app.inject({
      method: "POST",
      url: "/feedback",
      headers: bearerHeaders(),
      payload
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ stored: 1, duplicates: 1, unknownFingerprints: 0 });
    expect(created[0]).toMatchObject({
      orgId: "org_1",
      repoId: "repo_1",
      ruleId: "rule-1",
      severity: "high",
      verdict: "accepted"
    });
    expect(db.finding.findMany).toHaveBeenCalledTimes(1);
    expect(db.findingFeedback.createMany).toHaveBeenCalledTimes(1);
    expect(db.findingFeedback.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ fingerprint: "fp-1", verdict: "accepted" })
        ]),
        skipDuplicates: true
      })
    );
    await app.close();
  });

  test("scopes feedback attribution to the requested repository", async () => {
    const app = Fastify({ logger: false });
    const { db } = makeDb(true);
    registerFeedbackRoutes(app, { db } as any);

    const response = await app.inject({
      method: "POST",
      url: "/feedback",
      headers: bearerHeaders(),
      payload: {
        repo: "owner/repo",
        events: [{ fingerprint: "fp-1", verdict: "dismissed", source: "github-reaction" }]
      }
    });

    expect(response.statusCode).toBe(201);
    expect(db.repository.findFirst).toHaveBeenCalledWith({
      where: { orgId: "org_1", fullName: "owner/repo" },
      select: { id: true }
    });
    expect(db.finding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          fingerprint: { in: ["fp-1"] },
          orgId: "org_1",
          repoId: "repo_1"
        }
      })
    );
    await app.close();
  });

  test("rejects repository-scoped feedback when the repository is unknown", async () => {
    const app = Fastify({ logger: false });
    const { db } = makeDb(true);
    db.repository.findFirst = vi.fn(async () => null);
    registerFeedbackRoutes(app, { db } as any);

    const response = await app.inject({
      method: "POST",
      url: "/feedback",
      headers: bearerHeaders(),
      payload: {
        repo: "owner/missing",
        events: [{ fingerprint: "fp-1", verdict: "dismissed", source: "github-reaction" }]
      }
    });

    expect(response.statusCode).toBe(404);
    expect(db.finding.findMany).not.toHaveBeenCalled();
    await app.close();
  });

  test("skips fingerprints that match no stored finding", async () => {
    const app = Fastify({ logger: false });
    const { db } = makeDb(false);
    registerFeedbackRoutes(app, { db } as any);

    const response = await app.inject({
      method: "POST",
      url: "/feedback",
      headers: bearerHeaders(),
      payload: { repo: "owner/repo", events: [{ fingerprint: "ghost", verdict: "dismissed", source: "import" }] }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ stored: 0, unknownFingerprints: 1 });
    await app.close();
  });

  test("requires repository scope for feedback attribution", async () => {
    const app = Fastify({ logger: false });
    const { db } = makeDb(true);
    registerFeedbackRoutes(app, { db } as any);

    const response = await app.inject({
      method: "POST",
      url: "/feedback",
      headers: bearerHeaders(),
      payload: { events: [{ fingerprint: "fp-1", verdict: "dismissed", source: "import" }] }
    });

    expect(response.statusCode).toBe(400);
    expect(db.finding.findMany).not.toHaveBeenCalled();
    await app.close();
  });

  test("rejects malformed verdicts", async () => {
    const app = Fastify({ logger: false });
    const { db } = makeDb(true);
    registerFeedbackRoutes(app, { db } as any);

    const response = await app.inject({
      method: "POST",
      url: "/feedback",
      headers: bearerHeaders(),
      payload: { events: [{ fingerprint: "fp", verdict: "maybe", source: "import" }] }
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
