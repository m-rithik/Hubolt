import { describe, expect, test } from "vitest";
import { parseNameStatus } from "../../src/core/git.js";

describe("parseNameStatus", () => {
  test("parses added, modified, and deleted files", () => {
    const output = "A\tsrc/new.ts\nM\tsrc/changed.ts\nD\tsrc/old.ts\n";

    expect(parseNameStatus(output)).toEqual([
      { path: "src/new.ts", status: "added" },
      { path: "src/changed.ts", status: "modified" },
      { path: "src/old.ts", status: "deleted" }
    ]);
  });

  test("reports the new path for renames", () => {
    const output = "R100\tsrc/old.ts\tsrc/new.ts\n";

    expect(parseNameStatus(output)).toEqual([{ path: "src/new.ts", status: "renamed" }]);
  });

  test("ignores blank lines and unknown status codes", () => {
    expect(parseNameStatus("\n\nX\tsrc/weird.ts\n")).toEqual([]);
  });
});
