import { describe, expect, test } from "vitest";
import { hashPassword, verifyPassword } from "../../src/server/auth/passwords.js";

describe("passwords", () => {
  test("hash does not contain the plaintext and has the scrypt format", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct horse");
    expect(hash).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  });

  test("verifies the correct password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  test("rejects the wrong password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password", hash)).toBe(false);
  });

  test("rejects malformed stored values", () => {
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(verifyPassword("x", "bcrypt$aa$bb")).toBe(false);
  });

  test("two hashes of the same password differ (random salt)", () => {
    expect(hashPassword("same-password-value")).not.toBe(hashPassword("same-password-value"));
  });
});
