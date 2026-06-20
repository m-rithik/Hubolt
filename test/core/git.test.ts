import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { getChangedFiles, getDiffText, getGitRoot, parseNameStatus } from "../../src/core/git.js";

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

describe("ref option-injection guard", () => {
  test("rejects base/head refs that could be parsed as git options", () => {
    // The guard throws before spawning git, so no repository is needed.
    expect(() => getChangedFiles({ base: "-foo", head: "main" })).toThrow(/Invalid git base ref/);
    expect(() => getChangedFiles({ base: "main", head: "--upload-pack=x" })).toThrow(/Invalid git head ref/);
    expect(() => getDiffText({ base: "-foo", head: "main" })).toThrow(/Invalid git base ref/);
  });
});

describe("getGitRoot", () => {
  test("returns the repository root from a nested directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubolt-git-"));
    try {
      execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
      mkdirSync(join(dir, "src", "nested"), { recursive: true });

      expect(realpathSync(getGitRoot(join(dir, "src", "nested")))).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
