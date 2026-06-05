import { describe, expect, test } from "vitest";
import { generateApiKey, hashApiKey } from "../../src/server/api-keys.js";

describe("api key helpers", () => {
  test("generates Hubolt-prefixed API keys", () => {
    expect(generateApiKey()).toMatch(/^hubolt_[a-f0-9]{64}$/);
  });

  test("hashes keys without preserving the plaintext token", () => {
    const key = "hubolt_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const hash = hashApiKey(key);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe(key);
    expect(hashApiKey(key)).toBe(hash);
  });
});
