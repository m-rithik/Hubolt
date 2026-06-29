import { describe, expect, test, vi } from "vitest";
import { BitbucketScmProvider } from "../../src/providers/scm/bitbucket/index.js";

function overflowingPaginatedFetch() {
  let calls = 0;
  return vi.fn(async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        values: [],
        next: `https://api.bitbucket.org/2.0/next/${calls}`
      })
    } as unknown as Response;
  });
}

describe("BitbucketScmProvider pagination", () => {
  test("fails rather than returning incomplete issue comments", async () => {
    const fetchImpl = overflowingPaginatedFetch();
    const provider = new BitbucketScmProvider({
      repoFullName: "workspace/repo",
      token: "token",
      fetchImpl
    });

    await expect(provider.listIssueComments(7)).rejects.toThrow(/pagination exceeded/i);
    expect(fetchImpl).toHaveBeenCalledTimes(30);
  });

  test("compareCommits falls back when diffstat pagination overflows", async () => {
    const fetchImpl = overflowingPaginatedFetch();
    const provider = new BitbucketScmProvider({
      repoFullName: "workspace/repo",
      token: "token",
      fetchImpl
    });

    await expect(provider.compareCommits("base", "head")).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(30);
  });
});
