import { describe, expect, test, vi } from "vitest";
import { buildHostedContext } from "../../src/queue/review-context.js";
import type { PullRequestFile } from "../../src/providers/scm/scm.interface.js";

const PATCH = ["@@ -1,2 +1,3 @@", " line one", "+added line", " line two"].join("\n");

function file(overrides: Partial<PullRequestFile>): PullRequestFile {
  return { filename: "src/a.ts", status: "modified", patch: PATCH, ...overrides };
}

describe("buildHostedContext", () => {
  test("loads content for reviewable files and derives changed ranges", async () => {
    const fetchContent = vi.fn(async () => "line one\nadded line\nline two\n");

    const context = await buildHostedContext({
      files: [file({})],
      fetchContent,
      ignoreGlobs: [],
      maxFileSizeKb: 256,
      maxContextTokens: 60000,
      scope: "pr #7"
    });

    expect(context.reviewable).toHaveLength(1);
    expect(context.reviewable[0]).toMatchObject({
      path: "src/a.ts",
      status: "modified",
      changedRanges: [{ startLine: 2, endLine: 2 }]
    });
    expect(context.reviewable[0].content).toContain("added line");
  });

  test("skips deleted, ignored, binary, oversized, and unreadable files", async () => {
    const bigContent = "x".repeat(2048);
    const fetchContent = vi.fn(async (path: string) => {
      if (path === "src/gone.ts") return null;
      if (path === "src/big.ts") return bigContent;
      return "ok\n";
    });

    const context = await buildHostedContext({
      files: [
        file({ filename: "src/removed.ts", status: "removed" }),
        file({ filename: "dist/build.js" }),
        file({ filename: "image.png", patch: undefined }),
        file({ filename: "src/big.ts" }),
        file({ filename: "src/gone.ts" }),
        file({ filename: "src/ok.ts" })
      ],
      fetchContent,
      ignoreGlobs: ["dist/**"],
      maxFileSizeKb: 1,
      maxContextTokens: 60000,
      scope: "pr #7"
    });

    const byPath = new Map(context.files.map((f) => [f.path, f]));
    expect(byPath.get("src/removed.ts")?.skipped).toBe("deleted");
    expect(byPath.get("dist/build.js")?.skipped).toBe("ignored");
    expect(byPath.get("image.png")?.skipped).toBe("too-large");
    expect(byPath.get("src/big.ts")?.skipped).toBe("too-large");
    expect(byPath.get("src/gone.ts")?.skipped).toBe("unreadable");
    expect(context.reviewable.map((f) => f.path)).toEqual(["src/ok.ts"]);
    expect(fetchContent).not.toHaveBeenCalledWith("dist/build.js");
  });

  test("enforces the total context token budget greedily in change order", async () => {
    // ~100 bytes each = ~25 tokens per file; a 40-token budget fits the
    // first file, cuts the second, and still fits a smaller third.
    const big = "x".repeat(100);
    const small = "y".repeat(40);
    const fetchContent = vi.fn(async (path) => (path === "src/c.ts" ? small : big));

    const context = await buildHostedContext({
      files: [
        file({ filename: "src/a.ts" }),
        file({ filename: "src/b.ts" }),
        file({ filename: "src/c.ts" })
      ],
      fetchContent,
      ignoreGlobs: [],
      maxFileSizeKb: 256,
      maxContextTokens: 40,
      scope: "pr #7"
    });

    const byPath = new Map(context.files.map((f) => [f.path, f]));
    expect(byPath.get("src/a.ts")?.skipped).toBeUndefined();
    expect(byPath.get("src/b.ts")?.skipped).toBe("over-budget");
    expect(byPath.get("src/b.ts")?.content).toBeUndefined();
    expect(byPath.get("src/c.ts")?.skipped).toBeUndefined();
    expect(context.reviewable.map((f) => f.path)).toEqual(["src/a.ts", "src/c.ts"]);
  });

  test("onlyPaths narrows reviewable files for incremental runs", async () => {
    const fetchContent = vi.fn(async () => "ok\n");

    const context = await buildHostedContext({
      files: [file({ filename: "src/a.ts" }), file({ filename: "src/b.ts" })],
      fetchContent,
      ignoreGlobs: [],
      maxFileSizeKb: 256,
      maxContextTokens: 60000,
      onlyPaths: new Set(["src/b.ts"]),
      scope: "pr #7"
    });

    expect(context.reviewable.map((f) => f.path)).toEqual(["src/b.ts"]);
    expect(fetchContent).toHaveBeenCalledTimes(1);
  });
});
