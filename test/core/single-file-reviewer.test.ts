import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildSingleFileContext } from "../../src/core/single-file-reviewer.js";

describe("buildSingleFileContext", () => {
  let dir: string;
  let filepath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hubolt-single-file-"));
    filepath = join(dir, "sample.ts");
    writeFileSync(filepath, "const a = 1;\nconst b = 2;\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns a BuiltContext whose files and reviewable hold the single file", () => {
    const context = buildSingleFileContext({ filepath, cwd: dir });

    // Regression: the builder used to return `allFiles` instead of `files`, so
    // consumers reading `context.files` (e.g. `--show-context`) crashed.
    expect(context.scope).toBe("file");
    expect(context.files.map((f) => f.path)).toEqual([filepath]);
    expect(context.reviewable.map((f) => f.path)).toEqual([filepath]);
    expect(context.reviewable[0].content).toContain("const a = 1;");
    // The shape `--show-context` exercises must not throw.
    expect(context.files.filter((entry) => entry.skipped)).toEqual([]);
  });
});
