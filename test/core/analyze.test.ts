import { describe, expect, test } from "vitest";
import { RepoConfigSchema } from "../../src/config/schema.js";
import { buildAnalyzerContext, runAnalyzers, selectAnalyzers } from "../../src/core/analyze.js";
import type { BuiltContext } from "../../src/core/context-builder.js";
import { registerAnalyzerProvider } from "../../src/providers/analyzers/registry.js";
import type { AnalyzerProvider } from "../../src/types/providers.js";

function context(content: string): BuiltContext {
  const file = { path: "src/a.ts", status: "modified" as const, changedRanges: [], content };
  return { scope: "working tree", files: [file], reviewable: [file] };
}

describe("selectAnalyzers", () => {
  test("includes registered analyzers and reports enabled-but-unimplemented ones", () => {
    const config = RepoConfigSchema.parse({});
    const { names, skipped } = selectAnalyzers(config);
    expect(names).toContain("secret-scan");
    expect(names).toContain("typescript");
    // eslint/semgrep/dependencies are enabled by default but not implemented yet.
    expect(skipped.map((item) => item.name)).toEqual(expect.arrayContaining(["eslint", "semgrep", "dependency-audit"]));
  });
});

describe("runAnalyzers", () => {
  test("secret-scan produces a signal for a hardcoded credential", async () => {
    const config = RepoConfigSchema.parse({});
    const ctx = buildAnalyzerContext(context('const apiKey = "sk-supersecretvalue1234567890";'), {
      repoRoot: "/tmp/repo",
      config
    });

    const result = await runAnalyzers(ctx, ["secret-scan"]);

    expect(result.ran).toEqual(["secret-scan"]);
    expect(result.signals.length).toBeGreaterThanOrEqual(1);
    expect(result.signals[0].analyzer).toBe("secret-scan");
    expect(result.signals[0].range.file).toBe("src/a.ts");
  });

  test("isolates a throwing analyzer as skipped instead of crashing", async () => {
    const exploding: AnalyzerProvider = {
      name: "boom",
      async isAvailable() {
        return true;
      },
      async analyze() {
        throw new Error("analyzer failed");
      }
    };
    registerAnalyzerProvider("boom", () => exploding);
    const config = RepoConfigSchema.parse({});
    const ctx = buildAnalyzerContext(context("const x = 1;"), { repoRoot: "/tmp/repo", config });

    const result = await runAnalyzers(ctx, ["boom"]);

    expect(result.ran).toEqual([]);
    expect(result.skipped).toEqual([{ name: "boom", reason: "analyzer failed" }]);
  });

  test("skips an unavailable analyzer", async () => {
    const unavailable: AnalyzerProvider = {
      name: "off",
      async isAvailable() {
        return false;
      },
      async analyze() {
        return [];
      }
    };
    registerAnalyzerProvider("off", () => unavailable);
    const config = RepoConfigSchema.parse({});
    const ctx = buildAnalyzerContext(context("const x = 1;"), { repoRoot: "/tmp/repo", config });

    const result = await runAnalyzers(ctx, ["off"]);

    expect(result.ran).toEqual([]);
    expect(result.skipped).toEqual([{ name: "off", reason: "not available in this environment" }]);
  });
});
