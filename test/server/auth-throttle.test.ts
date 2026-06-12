import { describe, expect, test } from "vitest";
import { LAST_USED_WRITE_INTERVAL_MS, shouldTouchLastUsed } from "../../src/server/middleware/auth.js";

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
