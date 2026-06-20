import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";
import { registerGatewayRoutes } from "../../src/server/routes/gateway.js";

const TOKEN = ["gateway", "route", "token"].join("_");
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
    }
  } as any;
}

function completePayload() {
  return {
    reviewContext: { scope: "standard" },
    system: "You are a reviewer.",
    user: "Review this change."
  };
}

describe("gateway route role enforcement", () => {
  test("a viewer key cannot spend budget via /gateway/complete", async () => {
    const app = Fastify({ logger: false });
    const processRequest = vi.fn();
    await registerGatewayRoutes(app, { processRequest } as any, makeDb("viewer"));

    const res = await app.inject({
      method: "POST",
      url: "/gateway/complete",
      headers: HEADERS,
      payload: completePayload()
    });

    expect(res.statusCode).toBe(403);
    expect(processRequest).not.toHaveBeenCalled();
    await app.close();
  });

  test("an admin key reaches the provider", async () => {
    const app = Fastify({ logger: false });
    const processRequest = vi.fn().mockResolvedValue({ content: "ok" });
    await registerGatewayRoutes(app, { processRequest } as any, makeDb("admin"));

    const res = await app.inject({
      method: "POST",
      url: "/gateway/complete",
      headers: HEADERS,
      payload: completePayload()
    });

    expect(res.statusCode).toBe(200);
    expect(processRequest).toHaveBeenCalled();
    await app.close();
  });
});
