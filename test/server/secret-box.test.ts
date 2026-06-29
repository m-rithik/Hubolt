import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import { encryptSecret, decryptSecret, secretFingerprint } from "../../src/server/crypto/secret-box.js";

beforeAll(() => {
  process.env.CREDENTIAL_MASTER_KEY = randomBytes(32).toString("base64");
});

describe("secret-box", () => {
  test("round-trips a secret", () => {
    const value = "ATCTT-some-repo-access-token-value";
    const encrypted = encryptSecret(value);
    expect(encrypted).not.toContain(value);
    expect(decryptSecret(encrypted)).toBe(value);
  });

  test("produces different ciphertext each time (random salt/iv)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  test("rejects tampered ciphertext", () => {
    const encrypted = encryptSecret("secret");
    const bytes = Buffer.from(encrypted, "base64");
    bytes[bytes.length - 1] ^= 0xff;
    expect(() => decryptSecret(bytes.toString("base64"))).toThrow();
  });

  test("fingerprint is stable and distinguishes values", () => {
    expect(secretFingerprint("a")).toBe(secretFingerprint("a"));
    expect(secretFingerprint("a")).not.toBe(secretFingerprint("b"));
  });
});
