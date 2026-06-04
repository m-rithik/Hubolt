import { describe, expect, test } from "vitest";
import { RepoConfigSchema } from "../../src/config/schema.js";
import { buildAnalyzerContext, runAnalyzers, selectAnalyzers } from "../../src/core/analyze.js";
import type { BuiltContext } from "../../src/core/context-builder.js";
import { registerAnalyzerProvider } from "../../src/providers/analyzers/registry.js";
import type { AnalyzerProvider } from "../../src/types/providers.js";

const MOCK_OPENAI_KEY = ["sk", "supersecretvalue1234567890"].join("-");

function context(content: string): BuiltContext {
  const file = { path: "src/a.ts", status: "modified" as const, changedRanges: [], content };
  return { scope: "working tree", files: [file], reviewable: [file] };
}

describe("selectAnalyzers", () => {
  test("includes all registered analyzers enabled by default", () => {
    const config = RepoConfigSchema.parse({});
    const { names, skipped } = selectAnalyzers(config);
    expect(names).toEqual(
      expect.arrayContaining(["secret-scan", "typescript", "eslint", "semgrep", "dependency-audit"])
    );
    expect(skipped).toEqual([]);
  });

  test("security mode forces enabled security analyzers even when generic flags are off", () => {
    const config = RepoConfigSchema.parse({ analyzers: { typescript: false, eslint: false, semgrep: false, secrets: false, dependencies: false } });
    const { names } = selectAnalyzers(config, { securityMode: true });
    expect(names).toContain("secret-scan");
    expect(names).toContain("semgrep");
    expect(names).toContain("dependency-audit");
    expect(names).not.toContain("typescript");
  });

  test("security mode respects security analyzer include toggles", () => {
    const config = RepoConfigSchema.parse({
      analyzers: { typescript: false, eslint: false, semgrep: false, secrets: false, dependencies: false },
      security: { includeSecretScan: false, includeSemgrepSecurityRules: false, includeDependencyAudit: false }
    });
    const { names } = selectAnalyzers(config, { securityMode: true });
    expect(names).toEqual([]);
  });
});

describe("runAnalyzers", () => {
  test("secret-scan produces a signal for a hardcoded credential", async () => {
    const config = RepoConfigSchema.parse({});
    const name = ["api", "Key"].join("");
    const ctx = buildAnalyzerContext(context(`const ${name} = "${MOCK_OPENAI_KEY}";`), {
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
