import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RepoConfigSchema } from "../../src/config/schema.js";
import { buildContext } from "../../src/core/context-builder.js";

let dir: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hubolt-ctx-"));
  git("init");
  git("config", "user.email", "test@hubolt.dev");
  git("config", "user.name", "Hubolt Test");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/keep.ts"), "const a = 1;\nconst b = 2;\n");
  git("add", "-A");
  git("commit", "-m", "init");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildContext", () => {
  test("loads content for staged files and respects ignore globs", async () => {
    writeFileSync(join(dir, "src/keep.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    writeFileSync(join(dir, "src/new.ts"), "export const greeting = 'hi';\n");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist/skip.ts"), "export const skip = true;\n");
    git("add", "-A");

    const config = RepoConfigSchema.parse({ ignore: ["dist/**"] });
    const built = await buildContext({ cwd: dir, staged: true, config });

    expect(built.scope).toBe("staged changes");

    const reviewablePaths = built.reviewable.map((file) => file.path).sort();
    expect(reviewablePaths).toEqual(["src/keep.ts", "src/new.ts"]);

    const ignored = built.files.find((file) => file.path === "dist/skip.ts");
    expect(ignored?.skipped).toBe("ignored");

    const keep = built.reviewable.find((file) => file.path === "src/keep.ts");
    expect(keep?.content).toContain("const c = 3;");
    expect(keep?.changedRanges.length).toBeGreaterThan(0);
  });

  test("marks oversized files as skipped instead of loading them", async () => {
    writeFileSync(join(dir, "src/big.ts"), `${"x".repeat(2048)}\n`);
    git("add", "-A");

    const config = RepoConfigSchema.parse({ maxFileSizeKb: 1 });
    const built = await buildContext({ cwd: dir, staged: true, config });

    const big = built.files.find((file) => file.path === "src/big.ts");
    expect(big?.skipped).toBe("too-large");
    expect(built.reviewable.map((file) => file.path)).not.toContain("src/big.ts");
  });

  test("enforces maxContextTokens across the whole context, first-fit", async () => {
    // ~25 tokens each at 4 bytes/token; a 40-token budget fits the first
    // alphabetical file, cuts the second, and still fits a smaller third.
    writeFileSync(join(dir, "src/aa.ts"), "x".repeat(100));
    writeFileSync(join(dir, "src/bb.ts"), "y".repeat(100));
    writeFileSync(join(dir, "src/cc.ts"), "z".repeat(40));
    git("add", "-A");

    const config = RepoConfigSchema.parse({ maxContextTokens: 40 });
    const built = await buildContext({ cwd: dir, staged: true, config });

    const byPath = new Map(built.files.map((file) => [file.path, file]));
    expect(byPath.get("src/aa.ts")?.skipped).toBeUndefined();
    expect(byPath.get("src/bb.ts")?.skipped).toBe("over-budget");
    expect(byPath.get("src/bb.ts")?.content).toBeUndefined();
    expect(byPath.get("src/cc.ts")?.skipped).toBeUndefined();
  });
});
