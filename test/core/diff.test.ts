import { describe, expect, test } from "vitest";
import { parseUnifiedDiff } from "../../src/core/diff.js";
import { parseNameStatus } from "../../src/core/git.js";

describe("parseUnifiedDiff", () => {
  test("collects added line ranges on the new side", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,5 @@",
      " const a = 1;",
      "+const b = 2;",
      "+const c = 3;",
      " const d = 4;",
      "-const e = 5;",
      " const f = 6;"
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual([
      { path: "src/a.ts", changedRanges: [{ startLine: 2, endLine: 3 }] }
    ]);
  });

  test("splits non-contiguous additions into separate ranges", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "+++ b/x.ts",
      "@@ -1,4 +1,5 @@",
      " a",
      "+b",
      " c",
      " d",
      "+e"
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual([
      { path: "x.ts", changedRanges: [{ startLine: 2, endLine: 2 }, { startLine: 5, endLine: 5 }] }
    ]);
  });

  test("ignores deleted files (new side is /dev/null)", () => {
    const diff = [
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-const a = 1;",
      "-const b = 2;"
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual([]);
  });

  test("handles multiple files", () => {
    const diff = [
      "diff --git a/one.ts b/one.ts",
      "+++ b/one.ts",
      "@@ -0,0 +1 @@",
      "+const one = 1;",
      "diff --git a/two.ts b/two.ts",
      "+++ b/two.ts",
      "@@ -0,0 +1 @@",
      "+const two = 2;"
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual([
      { path: "one.ts", changedRanges: [{ startLine: 1, endLine: 1 }] },
      { path: "two.ts", changedRanges: [{ startLine: 1, endLine: 1 }] }
    ]);
  });
});

describe("parseNameStatus", () => {
  test("treats git type changes as modified files", () => {
    expect(parseNameStatus("T\tsrc/keep.ts\n")).toEqual([
      { path: "src/keep.ts", status: "modified" }
    ]);
  });
});
