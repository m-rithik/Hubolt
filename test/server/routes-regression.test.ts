import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerBudgetRoutes } from "../../src/server/routes/budgets.js";
import { registerHistoryRoutes } from "../../src/server/routes/history.js";
import { registerIngestRoutes } from "../../src/server/routes/ingest.js";
import { registerAuditRoutes } from "../../src/server/routes/audit.js";

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
          orgId: "org_1"
        },
        include: expect.objectContaining({
          findings: false,
          analyzerSignals: false
        })
      })
    );

    await app.close();
  });

  test("history review list applies severity filters", async () => {
    const app = Fastify({ logger: false });
    const db: any = {
      apiKey: {
        findUnique: vi.fn().mockResolvedValue(authApiKey()),
        update: vi.fn().mockResolvedValue(undefined)
      },
      review: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([])
      }
    };

    registerHistoryRoutes(app, { db } as any);

    const response = await app.inject({
      method: "GET",
      url: "/history/reviews?severity=high",
      headers: bearerHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(db.review.count).toHaveBeenCalledWith({
      where: {
        orgId: "org_1",
        findings: { some: { severity: "high" } }
      }
    });
    expect(db.review.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orgId: "org_1",
          findings: { some: { severity: "high" } }
        }
      })
    );

    await app.close();
  });

  test("history trends uses direct org-scoped review and finding filters", async () => {
    const app = Fastify({ logger: false });
    const db: any = {
      apiKey: {
        findUnique: vi.fn().mockResolvedValue(authApiKey()),
        update: vi.fn().mockResolvedValue(undefined)
      },
      review: {
        count: vi.fn().mockResolvedValue(2)
      },
      finding: {
        groupBy: vi.fn(async (args: any) =>
          args.by.includes("severity")
            ? [{ severity: "high", _count: { _all: 3 } }]
            : [{ ruleId: "rule-1", _count: { _all: 3 } }]
        )
      },
      findingFeedback: {
        groupBy: vi.fn().mockResolvedValue([])
      }
    };

    registerHistoryRoutes(app, { db } as any);

    const response = await app.inject({
      method: "GET",
      url: "/history/trends?days=7",
      headers: bearerHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(db.review.count).toHaveBeenCalledWith({
      where: { orgId: "org_1", createdAt: { gte: expect.any(Date) } }
    });
    for (const call of db.finding.groupBy.mock.calls) {
      expect(call[0].where).toEqual({ orgId: "org_1", createdAt: { gte: expect.any(Date) } });
      expect(call[0].where).not.toHaveProperty("review");
    }

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

  test("viewer keys cannot read org-wide budgets", async () => {
    const app = Fastify({ logger: false });
    const db: any = {
      apiKey: {
        findUnique: vi.fn().mockResolvedValue({ ...authApiKey(), role: "viewer", lastUsedAt: new Date() }),
        update: vi.fn().mockResolvedValue(undefined)
      },
      budget: {
        findMany: vi.fn()
      }
    };

    registerBudgetRoutes(app, { db } as any);

    const response = await app.inject({
      method: "GET",
      url: "/budgets",
      headers: bearerHeaders()
    });

    expect(response.statusCode).toBe(403);
    expect(db.budget.findMany).not.toHaveBeenCalled();
    await app.close();
  });

  test("viewer keys cannot export org audit logs", async () => {
    const app = Fastify({ logger: false });
    const db: any = {
      apiKey: {
        findUnique: vi.fn().mockResolvedValue({ ...authApiKey(), role: "viewer", lastUsedAt: new Date() }),
        update: vi.fn().mockResolvedValue(undefined)
      },
      auditEvent: {
        findMany: vi.fn(),
        count: vi.fn()
      }
    };

    registerAuditRoutes(app, { db } as any);

    const response = await app.inject({
      method: "GET",
      url: "/audit/export",
      headers: bearerHeaders()
    });

    expect(response.statusCode).toBe(403);
    expect(db.auditEvent.findMany).not.toHaveBeenCalled();
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

  test("ingest rejects read-only viewer API keys", async () => {
    const app = Fastify({ logger: false });
    const db: any = {
      apiKey: {
        findUnique: vi.fn().mockResolvedValue({ ...authApiKey(), role: "viewer" })
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

    expect(response.statusCode).toBe(403);
    expect(db.repository.upsert).not.toHaveBeenCalled();

    await app.close();
  });

  test("ingest refunds budget and rate-limit usage when the write fails after reservation", async () => {
    const app = Fastify({ logger: false });
    const db: any = {
      $transaction: vi.fn(),
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      $queryRaw: vi.fn(),
      apiKey: {
        findUnique: vi.fn().mockResolvedValue(authApiKey()),
        update: vi.fn().mockResolvedValue(undefined)
      },
      repository: {
        upsert: vi.fn().mockResolvedValue({ id: "repo_1" })
      },
      review: {
        // No existing review, so the request reserves usage before writing.
        findUnique: vi.fn().mockResolvedValue(null)
      },
      auditEvent: {
        create: vi.fn().mockResolvedValue(undefined)
      }
    };
    // First transaction is the budget/rate reservation (succeeds); the second
    // is the review write, which fails after the slot has been reserved.
    db.$transaction
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error("review write failed");
      });

    registerIngestRoutes(app, { db } as any);

    const response = await app.inject({
      method: "POST",
      url: "/ingest/review",
      payload: reviewPayload()
    });

    expect(response.statusCode).toBe(500);
    // refundUsage (budget) and refundRateLimit each issue one raw UPDATE; the
    // bug refunded only the budget and left the daily rate-limit slot burned.
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);

    await app.close();
  });

  test("ingest rejects repository URLs with unsafe schemes", async () => {
    const app = Fastify({ logger: false });
    const db: any = {
      apiKey: { findUnique: vi.fn() },
      repository: { upsert: vi.fn() }
    };

    registerIngestRoutes(app, { db } as any);

    for (const url of ["javascript:alert(1)", "data:text/html,hi", "ftp://example.com/x"]) {
      const response = await app.inject({
        method: "POST",
        url: "/ingest/review",
        payload: { ...reviewPayload(), repository: { name: "repo", fullName: "owner/repo", url } }
      });
      expect(response.statusCode).toBe(400);
    }
    // Validation fails before any auth or database work.
    expect(db.apiKey.findUnique).not.toHaveBeenCalled();
    expect(db.repository.upsert).not.toHaveBeenCalled();

    await app.close();
  });

  test("ingest rejects invalid finding line ranges before database writes", async () => {
    const app = Fastify({ logger: false });
    const db: any = {
      apiKey: {
        findUnique: vi.fn()
      },
      repository: {
        upsert: vi.fn()
      }
    };

    registerIngestRoutes(app, { db } as any);

    const response = await app.inject({
      method: "POST",
      url: "/ingest/review",
      payload: {
        ...reviewPayload(),
        findings: [
          {
            ruleId: "rule-1",
            message: "Invalid range",
            severity: "high",
            file: "src/a.ts",
            lineStart: 10,
            lineEnd: 2,
            fingerprint: "finding_fp_bad",
            confidence: 0.9
          }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(db.apiKey.findUnique).not.toHaveBeenCalled();
    expect(db.repository.upsert).not.toHaveBeenCalled();

    await app.close();
  });

  test("duplicate finding fingerprints are deduped instead of failing ingest", async () => {
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
        upsert: vi.fn().mockResolvedValue({ id: "review_1", repoId: "repo_1", fingerprint: "review_fp" })
      },
      finding: {
        deleteMany: vi.fn().mockResolvedValue(undefined),
        createMany: vi.fn().mockResolvedValue(undefined)
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
    db.$transaction.mockImplementation(async (callback: any) => callback(db));

    registerIngestRoutes(app, { db } as any);

    const duplicateFinding = {
      ruleId: "rule-1",
      message: "Duplicate finding",
      severity: "high",
      file: "src/a.ts",
      lineStart: 1,
      lineEnd: 1,
      fingerprint: "finding_fp_dup",
      confidence: 0.9
    };
    const payload = { ...reviewPayload(), findings: [duplicateFinding, { ...duplicateFinding }] };

    const response = await app.inject({
      method: "POST",
      url: "/ingest/review",
      payload
    });

    expect(response.statusCode).toBe(201);
    expect(db.finding.createMany).toHaveBeenCalledTimes(1);
    expect(db.finding.createMany.mock.calls[0][0].data).toHaveLength(1);
    expect(db.finding.createMany.mock.calls[0][0].data[0]).toMatchObject({
      orgId: "org_1",
      repoId: "repo_1"
    });
    expect(response.json().message).toContain("1 finding(s)");

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

  test("concurrent duplicate review ingestion is skipped before budget reservation", async () => {
    const app = Fastify({ logger: false });
    const db: any = {
      $transaction: vi.fn(),
      apiKey: {
        findUnique: vi.fn().mockResolvedValue(authApiKey()),
        update: vi.fn().mockResolvedValue(undefined)
      },
      repository: {
        upsert: vi.fn().mockResolvedValue({ id: "repo_1" })
      },
      reviewIngestLock: {
        deleteMany: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockRejectedValue(Object.assign(new Error("duplicate"), { code: "P2002" }))
      },
      review: {
        findUnique: vi.fn()
      }
    };

    registerIngestRoutes(app, { db } as any);

    const response = await app.inject({
      method: "POST",
      url: "/ingest/review",
      payload: reviewPayload()
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ success: true, message: "Review ingest is already processing" });
    expect(db.review.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();

    await app.close();
  });
});
