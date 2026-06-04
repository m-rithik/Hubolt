import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { toRepoAbsolutePath } from "../../src/providers/analyzers/typescript.js";

describe("typescript analyzer path handling", () => {
  test("resolves relative diagnostic paths from the analyzer repo root", () => {
    const repoRoot = resolve("/tmp/hubolt-repo");

    expect(toRepoAbsolutePath(repoRoot, "src/a.ts")).toBe(resolve(repoRoot, "src/a.ts"));
  });

  test("preserves absolute diagnostic paths", () => {
    const repoRoot = resolve("/tmp/hubolt-repo");
    const absolute = resolve(repoRoot, "src/a.ts");

    expect(toRepoAbsolutePath(repoRoot, absolute)).toBe(absolute);
  });
});
