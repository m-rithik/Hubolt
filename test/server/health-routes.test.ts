import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";
import { registerHealthRoutes } from "../../src/server/routes/health.js";

describe("readiness route", () => {
  test("returns ready when the database responds", async () => {
    const app = Fastify({ logger: false });
    registerHealthRoutes(app, { db: { $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]) } } as any);

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ready: true });
    await app.close();
  });

  test("does not leak raw dependency errors when the database is down", async () => {
    const app = Fastify({ logger: false });
    const db = { $queryRaw: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED db.internal:5432")) };
    registerHealthRoutes(app, { db } as any);

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ready: false });
    // The internal hostname/port must not appear in the public body.
    expect(response.body).not.toContain("db.internal");
    expect(response.body).not.toContain("ECONNREFUSED");
    await app.close();
  });
});
