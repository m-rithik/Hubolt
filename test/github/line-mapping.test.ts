import { describe, expect, test } from "vitest";
import {
  buildDiffIndex,
  buildFileDiffIndex,
  isRangeFullyAdded,
  mapRangeToComment
} from "../../src/github/line-mapping.js";
import type { ReviewRange } from "../../src/types/finding.js";

// Old file lines 10-13 become new lines 10-14: line 11 modified (delete+add),
// line 13 gets two lines inserted after it.
const PATCH = [
  "@@ -10,4 +10,5 @@ function demo() {",
  " const a = 1;",
  "-const b = old();",
  "+const b = updated();",
  " const c = 3;",
  "+const inserted1 = 4;",
  "+const inserted2 = 5;"
].join("\n");

const SECOND_HUNK_PATCH = [
  "@@ -1,2 +1,2 @@",
  "-old line one",
  "+new line one",
  " shared line",
  "@@ -10,2 +10,2 @@",
  " context",
  "-removed",
  "+added"
].join("\n");

function range(partial: Partial<ReviewRange> & { startLine: number; endLine: number }): ReviewRange {
  return {
    file: "src/a.ts",
    diffSide: "right",
    ...partial
  } as ReviewRange;
}

describe("buildFileDiffIndex", () => {
  test("tracks right-side context and added lines with file coordinates", () => {
    const index = buildFileDiffIndex(PATCH);

    expect([...index.rightLines].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14]);
    expect([...index.addedLines].sort((a, b) => a - b)).toEqual([11, 13, 14]);
    expect([...index.leftLines].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  test("assigns hunk ids so ranges cannot span hunks", () => {
    const index = buildFileDiffIndex(SECOND_HUNK_PATCH);

    expect(index.rightHunkByLine.get(1)).toBe(0);
    expect(index.rightHunkByLine.get(10)).toBe(1);
    expect(index.rightHunkByLine.get(11)).toBe(1);
  });
});

describe("mapRangeToComment", () => {
  const index = buildDiffIndex([{ filename: "src/a.ts", status: "modified", patch: PATCH }]);

  test("maps a single visible line", () => {
    const result = mapRangeToComment(range({ startLine: 11, endLine: 11 }), index);
    expect(result).toEqual({
      mappable: true,
      comment: { path: "src/a.ts", line: 11, side: "RIGHT", coverage: "full" }
    });
  });

  test("maps a fully visible multi-line range", () => {
    const result = mapRangeToComment(range({ startLine: 10, endLine: 14 }), index);
    expect(result).toEqual({
      mappable: true,
      comment: { path: "src/a.ts", line: 14, startLine: 10, side: "RIGHT", coverage: "full" }
    });
  });

  test("degrades to the end line when the range start is outside the diff", () => {
    const result = mapRangeToComment(range({ startLine: 5, endLine: 11 }), index);
    expect(result).toEqual({
      mappable: true,
      comment: { path: "src/a.ts", line: 11, side: "RIGHT", coverage: "endLine" }
    });
  });

  test("rejects lines outside the diff and unknown files", () => {
    expect(mapRangeToComment(range({ startLine: 99, endLine: 99 }), index)).toMatchObject({
      mappable: false
    });
    expect(
      mapRangeToComment(range({ file: "src/other.ts", startLine: 11, endLine: 11 }), index)
    ).toMatchObject({ mappable: false, reason: "file is not part of this diff" });
  });

  test("maps deleted-line findings on the left side", () => {
    const result = mapRangeToComment(
      range({ startLine: 11, endLine: 11, diffSide: "left" }),
      index
    );
    expect(result).toEqual({
      mappable: true,
      comment: { path: "src/a.ts", line: 11, side: "LEFT", coverage: "full" }
    });
  });

  test("does not span hunks in multi-line mappings", () => {
    const multiHunk = buildDiffIndex([
      { filename: "src/a.ts", status: "modified", patch: SECOND_HUNK_PATCH }
    ]);

    const result = mapRangeToComment(range({ startLine: 1, endLine: 11 }), multiHunk);
    expect(result).toMatchObject({
      mappable: true,
      comment: { line: 11, coverage: "endLine" }
    });
  });
});

describe("isRangeFullyAdded", () => {
  const index = buildDiffIndex([{ filename: "src/a.ts", status: "modified", patch: PATCH }]);

  test("true only when every line in the range was added", () => {
    expect(isRangeFullyAdded(range({ startLine: 13, endLine: 14 }), index)).toBe(true);
    expect(isRangeFullyAdded(range({ startLine: 11, endLine: 11 }), index)).toBe(true);
    expect(isRangeFullyAdded(range({ startLine: 10, endLine: 11 }), index)).toBe(false);
    expect(isRangeFullyAdded(range({ startLine: 12, endLine: 12 }), index)).toBe(false);
  });

  test("false for left-side ranges and unknown files", () => {
    expect(isRangeFullyAdded(range({ startLine: 11, endLine: 11, diffSide: "left" }), index)).toBe(false);
    expect(isRangeFullyAdded(range({ file: "nope.ts", startLine: 11, endLine: 11 }), index)).toBe(false);
  });
});
