import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";
import { registerRateLimitRoutes } from "../../src/server/routes/rate-limits.js";

const TOKEN = ["rate", "limit", "token"].join("_");
const HEADERS = { authorization: `Bearer ${TOKEN}` };

function makeDb(role: string) {
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
    rateLimitWindow: {
      upsert: vi.fn().mockResolvedValue({
        id: "w1",
        provider: "openai",
        model: "gpt-4o-mini",
        requestCount: 0,
        maxRequestsPerDay: 100,
        windowStart: new Date("2026-06-20T00:00:00.000Z")
      })
    },
    auditEvent: { create: vi.fn().mockResolvedValue(undefined) }
  } as any;
}

describe("rate-limit route role enforcement", () => {
  test("a viewer key cannot change a rate limit", async () => {
    const app = Fastify({ logger: false });
    const db = makeDb("viewer");
    registerRateLimitRoutes(app, { db });

    const res = await app.inject({
      method: "PATCH",
      url: "/rate-limits/openai/gpt-4o-mini",
      headers: HEADERS,
      payload: { maxRequestsPerDay: 100 }
    });

    expect(res.statusCode).toBe(403);
    expect(db.rateLimitWindow.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  test("an admin key can change a rate limit", async () => {
    const app = Fastify({ logger: false });
    const db = makeDb("admin");
    registerRateLimitRoutes(app, { db });

    const res = await app.inject({
      method: "PATCH",
      url: "/rate-limits/openai/gpt-4o-mini",
      headers: HEADERS,
      payload: { maxRequestsPerDay: 100 }
    });

    expect(res.statusCode).toBe(200);
    expect(db.rateLimitWindow.upsert).toHaveBeenCalled();
    await app.close();
  });
});
