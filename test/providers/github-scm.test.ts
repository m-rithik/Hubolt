import { describe, expect, test, vi } from "vitest";
import { GitHubScmProvider, ScmError, parseNextLink } from "../../src/providers/scm/github/client.js";

const TOKEN = ["unit", "test", "scm", "token"].join("-");

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers }
  });
}

function buildProvider(fetchImpl: typeof fetch) {
  return new GitHubScmProvider({
    repoFullName: "owner/repo",
    token: TOKEN,
    fetchImpl
  });
}

describe("GitHubScmProvider", () => {
  test("rejects malformed repository slugs and missing tokens", () => {
    expect(() => new GitHubScmProvider({ repoFullName: "not a slug", token: TOKEN })).toThrow(/Invalid repository slug/);
    expect(() => new GitHubScmProvider({ repoFullName: "owner/repo", token: "" })).toThrow(/token is required/);
  });

  test("lists pull request files across pages and maps field names", async () => {
    const page1 = [{ filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@" }];
    const page2 = [{ filename: "b.ts", status: "renamed", previous_filename: "old-b.ts" }];
    const fetchImpl = vi.fn(async (url: any) => {
      if (String(url).includes("per_page")) {
        return jsonResponse(page1, {
          headers: { link: '<https://api.github.com/repos/owner/repo/pulls/7/files?page=2>; rel="next"' }
        });
      }
      return jsonResponse(page2);
    }) as unknown as typeof fetch;

    const provider = buildProvider(fetchImpl);
    const files = await provider.listPullRequestFiles(7);

    expect(files).toEqual([
      { filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@", previousFilename: undefined },
      { filename: "b.ts", status: "renamed", patch: undefined, previousFilename: "old-b.ts" }
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("returns null for missing file content and raw text for found files", async () => {
    const fetchImpl = vi.fn(async (url: any) => {
      if (String(url).includes("missing.ts")) {
        return new Response("", { status: 404 });
      }
      return new Response("const x = 1;\n", { status: 200 });
    }) as unknown as typeof fetch;

    const provider = buildProvider(fetchImpl);

    await expect(provider.getFileContent("missing.ts", "headsha")).resolves.toBeNull();
    await expect(provider.getFileContent("src/a.ts", "headsha")).resolves.toBe("const x = 1;\n");

    const calledUrl = String((fetchImpl as any).mock.calls[1][0]);
    expect(calledUrl).toContain("/repos/owner/repo/contents/src/a.ts?ref=headsha");
  });

  test("errors carry status and truncated API message but never the token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "Validation Failed" }, { status: 422 })
    ) as unknown as typeof fetch;

    const provider = buildProvider(fetchImpl);

    const error = await provider.listIssueComments(7).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScmError);
    expect((error as ScmError).statusCode).toBe(422);
    expect((error as ScmError).message).toContain("Validation Failed");
    expect((error as ScmError).message).not.toContain(TOKEN);
  });

  test("createReview posts an atomic review with mapped inline comments", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1 })) as unknown as typeof fetch;
    const provider = buildProvider(fetchImpl);

    await provider.createReview(7, "headsha", "Summary body", [
      { path: "src/a.ts", body: "Single line", line: 5, side: "RIGHT" },
      { path: "src/b.ts", body: "Multi line", line: 12, startLine: 10, side: "RIGHT" }
    ]);

    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(String(url)).toContain("/repos/owner/repo/pulls/7/reviews");
    const payload = JSON.parse(init.body);
    expect(payload).toMatchObject({
      commit_id: "headsha",
      event: "COMMENT",
      body: "Summary body"
    });
    expect(payload.comments[0]).toEqual({ path: "src/a.ts", body: "Single line", line: 5, side: "RIGHT" });
    expect(payload.comments[1]).toEqual({
      path: "src/b.ts",
      body: "Multi line",
      line: 12,
      side: "RIGHT",
      start_line: 10,
      start_side: "RIGHT"
    });
  });

  test("compareCommits returns changed paths but null when truncated or missing", async () => {
    const smallDiff = { files: [{ filename: "a.ts" }, { filename: "b.ts" }] };
    const truncatedDiff = { files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts` })) };

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(smallDiff))
      .mockResolvedValueOnce(jsonResponse(truncatedDiff))
      .mockResolvedValueOnce(new Response("", { status: 404 })) as unknown as typeof fetch;
    const provider = buildProvider(fetchImpl);

    await expect(provider.compareCommits("base", "head")).resolves.toEqual(["a.ts", "b.ts"]);
    await expect(provider.compareCommits("base", "head")).resolves.toBeNull();
    await expect(provider.compareCommits("gone", "head")).resolves.toBeNull();
  });

  test("requests send auth and api-version headers", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;
    const provider = buildProvider(fetchImpl);

    await provider.listReviewComments(7);

    const [, init] = (fetchImpl as any).mock.calls[0];
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["x-github-api-version"]).toBe("2022-11-28");
  });
});

describe("parseNextLink", () => {
  test("extracts rel=next and ignores other rels", () => {
    const header =
      '<https://api.github.com/x?page=3>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
    expect(parseNextLink(header)).toBe("https://api.github.com/x?page=3");
    expect(parseNextLink('<https://api.github.com/x?page=9>; rel="last"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});
