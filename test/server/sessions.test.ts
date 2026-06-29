import { describe, expect, test } from "vitest";
import { generateSessionToken, hashSessionToken, isSessionToken } from "../../src/server/auth/sessions.js";

describe("sessions", () => {
  test("generates a prefixed, unique token", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(isSessionToken(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  test("hash is a deterministic sha256 of the token", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).not.toBe(hashSessionToken(generateSessionToken()));
  });

  test("rejects non-session tokens", () => {
    expect(isSessionToken("hubolt_abc")).toBe(false);
  });
});
