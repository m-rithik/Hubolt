import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import type { AnalyzerSignal, Severity } from "../../types/finding.js";
import type { AnalyzerContext, AnalyzerProvider } from "../../types/providers.js";

/** Subset of an ESLint result we rely on. */
interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}
interface EslintResult {
  filePath: string;
  messages: EslintMessage[];
}

const CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml"
];

/**
 * ESLint analyzer. Lints the changed files using the repository's own ESLint
 * install and config. Degrades to unavailable when ESLint or a config is
 * missing, so it never fails a review on its own.
 */
export function makeEslintAnalyzer(): AnalyzerProvider {
  return {
    name: "eslint",
    async isAvailable(ctx: AnalyzerContext): Promise<boolean> {
      if (!CONFIG_FILES.some((file) => existsSync(join(ctx.repoRoot, file)))) {
        return false;
      }
      return loadEslint(ctx.repoRoot) !== null;
    },
    async analyze(ctx: AnalyzerContext): Promise<AnalyzerSignal[]> {
      const ESLint = loadEslint(ctx.repoRoot);
      if (!ESLint) {
        return [];
      }

      const eslint = new ESLint({ cwd: ctx.repoRoot });
      const paths = ctx.files.map((file) => resolve(ctx.repoRoot, file.path));
      const results = (await eslint.lintFiles(paths)) as EslintResult[];
      return mapEslintResults(results, ctx.repoRoot);
    }
  };
}

/** Convert ESLint results into analyzer signals. Pure, so it is unit-testable. */
export function mapEslintResults(results: EslintResult[], repoRoot: string): AnalyzerSignal[] {
  const signals: AnalyzerSignal[] = [];

  for (const result of results) {
    const path = relative(repoRoot, result.filePath) || result.filePath;
    for (const message of result.messages) {
      const startLine = message.line ?? 1;
      const endLine = Math.max(startLine, message.endLine ?? startLine);
      const ruleId = message.ruleId ?? "parse-error";

      signals.push({
        id: `eslint:${ruleId}:${path}:${startLine}`,
        analyzer: "eslint",
        ruleId: `eslint.${ruleId}`,
        range: {
          file: path,
          startLine,
          endLine,
          startColumn: message.column,
          endColumn: message.endColumn,
          diffSide: "right"
        },
        severity: severityFor(message.severity, message.ruleId),
        message: message.message,
        evidence: [`eslint ${ruleId}`]
      });
    }
  }

  return signals;
}

function severityFor(severity: number, ruleId: string | null): Severity {
  if (ruleId === null) {
    return "high"; // parse errors block linting entirely
  }
  return severity === 2 ? "medium" : "low";
}

// eslint is an optional peer; resolve it from the target repo without a static
// import so the build does not require it as a dependency.
function loadEslint(repoRoot: string): (new (options: { cwd: string }) => { lintFiles(paths: string[]): Promise<unknown> }) | null {
  try {
    const requireFromRepo = createRequire(join(repoRoot, "package.json"));
    const mod = requireFromRepo("eslint") as { ESLint?: unknown };
    return (mod.ESLint as never) ?? null;
  } catch {
    return null;
  }
}
