import { describe, expect, test, vi } from "vitest";
import { readableRepoIds } from "../../src/server/services/repository-access.js";

function db(grantedRepoIds: string[]) {
  return {
    organizationMember: { findFirst: vi.fn().mockResolvedValue({ id: "m1" }) },
    repositoryAccess: { findMany: vi.fn().mockResolvedValue(grantedRepoIds.map((repoId) => ({ repoId }))) }
  } as never;
}

describe("readableRepoIds (Finding #4)", () => {
  test("admins are unrestricted (null)", async () => {
    expect(await readableRepoIds(db([]), "orgA", "u1", true)).toBeNull();
  });

  test("org-level API keys (no session user) are unrestricted (null)", async () => {
    expect(await readableRepoIds(db([]), "orgA", undefined, false)).toBeNull();
  });

  test("session developers are restricted to their granted repos", async () => {
    const ids = await readableRepoIds(db(["r1", "r2"]), "orgA", "u1", false);
    expect(ids).toEqual(["r1", "r2"]);
  });

  test("a developer with no grants gets an empty allow-list", async () => {
    expect(await readableRepoIds(db([]), "orgA", "u1", false)).toEqual([]);
  });
});
