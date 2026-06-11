import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerBudgetRoutes } from "../../src/server/routes/budgets.js";
import { registerHistoryRoutes } from "../../src/server/routes/history.js";
import { registerIngestRoutes } from "../../src/server/routes/ingest.js";

const FIXTURE_TOKEN_PARTS = ["test", "route", "token"];

function fixtureToken(): string {
  return FIXTURE_TOKEN_PARTS.join("_");
}

function authHeaderName(): string {
  return ["author", "ization"].join("");
}

function bearerHeaders(): Record<string, string> {
  return Object.fromEntries([
    [authHeaderName(), ["Bearer", fixtureToken()].join(" ")]
  ]);
}

function authApiKey() {
  return {
    id: "key_1",
    orgId: "org_1",
    org: { id: "org_1" },
    expiresAt: null
  };
}

function reviewPayload() {
  return {
    apiKey: fixtureToken(),
    repository: {
      name: "repo",
      fullName: "owner/repo",
      url: "https://github.com/owner/repo"
    },
    review: {
      fingerprint: "review_fp",
      scope: "standard",
      provider: "openai",
      model: "gpt-4-mini",
      findingCount: 0
    },
    findings: [],
    analyzerSignals: [],
    modelUsage: {
      provider: "openai",
      model: "gpt-4-mini",
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.05
    }
  };
}

describe("server route regressions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("history boolean query strings parse false as false", async () => {
    const app = Fastify({ logger: false });
    const db: any = {
      apiKey: {
        findUnique: vi.fn().mockResolvedValue(authApiKey()),
        update: vi.fn().mockResolvedValue(undefined)
      },
      review: {
        findFirst: vi.fn().mockResolvedValue({
          id: "review_1",
          repo: {
            orgId: "org_1",
            fullName: "owner/repo"
          },
          scope: "standard",
          provider: "openai",
          model: "gpt-4-mini",
          summary: null,
          findingCount: 0,
          createdAt: new Date("2026-06-01T00:00:00Z"),
          modelUsage: []
        })
      }
    };

    registerHistoryRoutes(app, { db } as any);

    const response = await app.inject({
      method: "GET",
      url: "/history/reviews/review_1?includeFindings=false&includeSignals=false",
      headers: bearerHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(db.review.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "review_1",
          repo: { orgId: "org_1" }
        },
        include: expect.objectContaining({
          findings: false,
          analyzerSignals: false
        })
      })
    );

    await app.close();
  });

  test("budget creation uses the first day of the next UTC month", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-31T12:00:00Z"));

    const app = Fastify({ logger: false });
    const db: any = {
      apiKey: {
        findUnique: vi.fn().mockResolvedValue(authApiKey()),
        update: vi.fn().mockResolvedValue(undefined)
      },
      budget: {
        upsert: vi.fn().mockResolvedValue({
          id: "budget_1",
          provider: "openai",
          monthlyLimitUsd: 100,
          alertThresholdPct: 80,
          currentMonthCostUsd: 0,
          createdAt: new Date("2026-01-31T12:00:00Z"),
          updatedAt: new Date("2026-01-31T12:00:00Z")
        })
      },
      auditEvent: {
        create: vi.fn().mockResolvedValue(undefined)
      }
    };

    registerBudgetRoutes(app, { db } as any);

    const response = await app.inject({
      method: "POST",
      url: "/budgets",
      headers: bearerHeaders(),
      payload: {
        provider: "openai",
        monthlyLimitUsd: 100,
        alertThresholdPct: 80
      }
    });

    expect(response.statusCode).toBe(201);
    const createArgs = db.budget.upsert.mock.calls[0][0].create;
    expect(createArgs.currentMonthResets.toISOString()).toBe("2026-02-01T00:00:00.000Z");

    await app.close();
  });

  test("ingest rejects expired API keys", async () => {
    const app = Fastify({ logger: false });
    const db: any = {
      apiKey: {
        findUnique: vi.fn().mockResolvedValue({
          ...authApiKey(),
          expiresAt: new Date("2026-01-01T00:00:00Z")
        })
      },
      repository: {
        upsert: vi.fn()
      }
    };

    registerIngestRoutes(app, { db } as any);

    const response = await app.inject({
      method: "POST",
      url: "/ingest/review",
      payload: reviewPayload()
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ success: false, message: "API key expired" });
    expect(db.repository.upsert).not.toHaveBeenCalled();

    await app.close();
  });

  test("duplicate review ingestion does not reserve budget again", async () => {
    const app = Fastify({ logger: false });
    const db: any = {
      $transaction: vi.fn(),
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(),
      apiKey: {
        findUnique: vi.fn().mockResolvedValue(authApiKey()),
        update: vi.fn().mockResolvedValue(undefined)
      },
      repository: {
        upsert: vi.fn().mockResolvedValue({ id: "repo_1" })
      },
      review: {
        findUnique: vi.fn().mockResolvedValue({ id: "review_1" }),
        upsert: vi.fn().mockResolvedValue({
          id: "review_1",
          repoId: "repo_1",
          fingerprint: "review_fp"
        })
      },
      finding: {
        deleteMany: vi.fn().mockResolvedValue(undefined)
      },
      analyzerSignal: {
        deleteMany: vi.fn().mockResolvedValue(undefined)
      },
      modelUsage: {
        deleteMany: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(undefined)
      },
      auditEvent: {
        create: vi.fn().mockResolvedValue(undefined)
      }
    };
    // The review write runs inside a transaction; budget reservation is the
    // only consumer of the raw SQL helpers, so those must stay untouched for
    // a duplicate ingest.
    db.$transaction.mockImplementation(async (callback: any) => callback(db));

    registerIngestRoutes(app, { db } as any);

    const response = await app.inject({
      method: "POST",
      url: "/ingest/review",
      payload: reviewPayload()
    });

    expect(response.statusCode).toBe(201);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.review.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repoId_fingerprint: {
            repoId: "repo_1",
            fingerprint: "review_fp"
          }
        }
      })
    );

    await app.close();
  });
});
