import { describe, expect, test, vi } from "vitest";
import { hashApiKey } from "../../src/server/api-keys.js";
import {
  createAuthMiddleware,
  isAuthenticated,
  LAST_USED_WRITE_INTERVAL_MS,
  shouldTouchLastUsed,
  type AuthenticatedRequest
} from "../../src/server/middleware/auth.js";

describe("lastUsedAt write throttling", () => {
  const now = new Date("2026-06-11T12:00:00Z");

  test("writes when the key has never been used", () => {
    expect(shouldTouchLastUsed(null, now)).toBe(true);
  });

  test("skips the write while the timestamp is fresh", () => {
    const fresh = new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS + 1000);
    expect(shouldTouchLastUsed(fresh, now)).toBe(false);
  });

  test("writes again once the interval has elapsed", () => {
    const stale = new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS - 1000);
    expect(shouldTouchLastUsed(stale, now)).toBe(true);
  });
});

describe("auth middleware", () => {
  test("marks requests authenticated without storing the raw bearer token", async () => {
    const token = ["unit", "auth", "token"].join("-");
    const db = {
      apiKey: {
        findUnique: vi.fn().mockResolvedValue({
          orgId: "org_1",
          org: { id: "org_1" },
          expiresAt: null,
          lastUsedAt: new Date()
        }),
        update: vi.fn()
      }
    };
    const request = {
      headers: { authorization: `Bearer ${token}` },
      server: { log: { error: vi.fn() } }
    } as unknown as AuthenticatedRequest;
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn()
    };

    await createAuthMiddleware(db as any)(request, reply as any);

    expect(db.apiKey.findUnique).toHaveBeenCalledWith({
      where: { keyHash: hashApiKey(token) },
      include: { org: true }
    });
    expect(isAuthenticated(request)).toBe(true);
    expect(request).not.toHaveProperty("apiKey");
  });
});
