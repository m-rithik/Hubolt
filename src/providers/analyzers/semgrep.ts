import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { AnalyzerSignal, Severity } from "../../types/finding.js";
import type { AnalyzerContext, AnalyzerProvider } from "../../types/providers.js";

const run = promisify(execFile);

interface SemgrepResult {
  check_id: string;
  path: string;
  start: { line: number; col: number };
  end: { line: number; col: number };
  extra?: { message?: string; severity?: string };
}

const REPO_CONFIG_FILES = [".semgrep.yml", ".semgrep.yaml", "semgrep.yml", "semgrep.yaml"];

/**
 * Semgrep analyzer. Optional: requires the `semgrep` CLI on PATH. Uses a repo
 * semgrep config when present, otherwise the registry "auto" config. Any failure
 * (missing binary, network, parse) degrades to no signals rather than an error.
 */
export function makeSemgrepAnalyzer(): AnalyzerProvider {
  return {
    name: "semgrep",
    async isAvailable(): Promise<boolean> {
      try {
        await run("semgrep", ["--version"], { timeout: 10_000 });
        return true;
      } catch {
        return false;
      }
    },
    async analyze(ctx: AnalyzerContext): Promise<AnalyzerSignal[]> {
      if (ctx.files.length === 0) {
        return [];
      }

      const config = REPO_CONFIG_FILES.map((file) => join(ctx.repoRoot, file)).find((path) => existsSync(path)) ?? "auto";
      const paths = ctx.files.map((file) => resolve(ctx.repoRoot, file.path));

      try {
        const { stdout } = await run("semgrep", ["--json", "--quiet", "--config", config, ...paths], {
          cwd: ctx.repoRoot,
          timeout: 120_000,
          maxBuffer: 50 * 1024 * 1024
        });
        return mapSemgrepResults(stdout, ctx.repoRoot);
      } catch {
        return [];
      }
    }
  };
}

/** Parse semgrep --json stdout into analyzer signals. Pure and unit-testable. */
export function mapSemgrepResults(stdout: string, repoRoot: string): AnalyzerSignal[] {
  let parsed: { results?: SemgrepResult[] };
  try {
    parsed = JSON.parse(stdout) as { results?: SemgrepResult[] };
  } catch {
    return [];
  }

  const signals: AnalyzerSignal[] = [];
  for (const result of parsed.results ?? []) {
    const path = isAbsolute(result.path) ? relative(repoRoot, result.path) || result.path : result.path;
    const startLine = result.start?.line ?? 1;
    const endLine = Math.max(startLine, result.end?.line ?? startLine);

    signals.push({
      id: `semgrep:${result.check_id}:${path}:${startLine}`,
      analyzer: "semgrep",
      ruleId: `semgrep.${result.check_id}`,
      range: {
        file: path,
        startLine,
        endLine,
        startColumn: result.start?.col,
        endColumn: result.end?.col,
        diffSide: "right"
      },
      severity: severityFor(result.extra?.severity),
      message: result.extra?.message?.trim() || result.check_id,
      evidence: [`semgrep ${result.check_id}`]
    });
  }

  return signals;
}

function severityFor(severity: string | undefined): Severity {
  switch ((severity ?? "").toUpperCase()) {
    case "ERROR":
      return "high";
    case "WARNING":
      return "medium";
    case "INFO":
      return "low";
    default:
      return "medium";
  }
}
