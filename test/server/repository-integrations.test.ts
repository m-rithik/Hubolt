import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
  upsertIntegration,
  IntegrationConflictError
} from "../../src/server/services/repository-integrations.js";

beforeAll(() => {
  process.env.CREDENTIAL_MASTER_KEY = randomBytes(32).toString("base64");
});

const baseInput = {
  orgId: "org1",
  repoId: "repoA",
  provider: "bitbucket",
  name: "Payments Service Bitbucket Connection",
  token: "ATCTT-token-A",
  webhookSecret: "whsecret-A"
};

function fakeDb(findFirstResults: Array<{ id: string } | null>) {
  const upsert = vi.fn().mockResolvedValue({ id: "int1" });
  const findFirst = vi.fn();
  for (const result of findFirstResults) findFirst.mockResolvedValueOnce(result);
  return { db: { repositoryIntegration: { findFirst, upsert } } as any, upsert };
}

describe("upsertIntegration uniqueness", () => {
  test("rejects a token already used by another integration", async () => {
    const { db } = fakeDb([{ id: "other" }]); // token clash on first lookup
    await expect(upsertIntegration(db, baseInput)).rejects.toBeInstanceOf(IntegrationConflictError);
  });

  test("rejects a webhook secret already used by another integration", async () => {
    const { db } = fakeDb([null, { id: "other" }]); // token ok, secret clash
    await expect(upsertIntegration(db, baseInput)).rejects.toBeInstanceOf(IntegrationConflictError);
  });

  test("creates when token and secret are unique", async () => {
    const { db, upsert } = fakeDb([null, null]);
    await upsertIntegration(db, baseInput);
    expect(upsert).toHaveBeenCalledOnce();
    const arg = upsert.mock.calls[0][0];
    // Secrets are encrypted, never stored in plaintext.
    expect(arg.create.encryptedToken).not.toContain("ATCTT-token-A");
    expect(arg.create.tokenFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
