import { afterEach, describe, expect, test, vi } from "vitest";
import { CredentialManager } from "../../src/server/services/credential-manager.js";
import { resolveGatewayApiKey } from "../../src/server/services/review-llm.js";

describe("resolveGatewayApiKey", () => {
  const original = process.env.CREDENTIAL_MASTER_KEY;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CREDENTIAL_MASTER_KEY;
    } else {
      process.env.CREDENTIAL_MASTER_KEY = original;
    }
    vi.restoreAllMocks();
  });

  test("returns undefined (env fallback) when no master key is configured", async () => {
    delete process.env.CREDENTIAL_MASTER_KEY;
    const db: any = { providerCredential: { findUnique: vi.fn() } };

    await expect(resolveGatewayApiKey(db, "org_1", "anthropic")).resolves.toBeUndefined();
    expect(db.providerCredential.findUnique).not.toHaveBeenCalled();
  });

  test("returns undefined (env fallback) when the org has no stored credential", async () => {
    process.env.CREDENTIAL_MASTER_KEY = CredentialManager.generateMasterKey();
    const db: any = { providerCredential: { findUnique: vi.fn().mockResolvedValue(null) } };

    await expect(resolveGatewayApiKey(db, "org_1", "anthropic")).resolves.toBeUndefined();
  });

  test("resolves a gateway Anthropic credential for legacy claude review config", async () => {
    process.env.CREDENTIAL_MASTER_KEY = CredentialManager.generateMasterKey();
    const db: any = {
      providerCredential: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            id: "cred_1",
            provider: "anthropic",
            encryptedKey: "ciphertext"
          }),
        update: vi.fn()
      }
    };
    vi.spyOn(CredentialManager.prototype, "getCredential")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("anthropic-key");

    await expect(resolveGatewayApiKey(db, "org_1", "claude")).resolves.toBe("anthropic-key");
  });

  test("fails closed when a stored credential cannot be decrypted", async () => {
    // Regression: a decrypt failure used to be swallowed and the review fell
    // back to the operator's environment key, billing the wrong account.
    process.env.CREDENTIAL_MASTER_KEY = CredentialManager.generateMasterKey();
    const db: any = {
      providerCredential: {
        findUnique: vi.fn().mockResolvedValue({
          id: "cred_1",
          provider: "anthropic",
          encryptedKey: "this-is-not-a-valid-ciphertext"
        }),
        update: vi.fn()
      }
    };

    await expect(resolveGatewayApiKey(db, "org_1", "anthropic")).rejects.toThrow();
  });
});
