import { dirname, isAbsolute, relative, resolve } from "node:path";
import type * as TS from "typescript";
import type { AnalyzerSignal, Severity } from "../../types/finding.js";

/**
 * The synchronous TypeScript analysis core, shared by the in-process fallback
 * and the worker thread. Builds a program from the repo tsconfig and gathers
 * diagnostics for the changed files only. This blocks the thread it runs on -
 * which is exactly why the analyzer prefers to run it inside a worker so the
 * main thread (and its progress spinner) stays responsive.
 */
export function runTypeScriptDiagnostics(
  ts: typeof TS,
  repoRoot: string,
  changedPaths: string[]
): AnalyzerSignal[] {
  const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    return [];
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config ?? {}, ts.sys, dirname(configPath));
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });

  const changed = new Set(changedPaths.map((path) => toRepoAbsolutePath(repoRoot, path)));
  const targets = program
    .getSourceFiles()
    .filter((sourceFile) => changed.has(toRepoAbsolutePath(repoRoot, sourceFile.fileName)));

  const signals: AnalyzerSignal[] = [];
  for (const sourceFile of targets) {
    const diagnostics = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile)
    ];
    for (const diagnostic of diagnostics) {
      if (diagnostic.file) {
        signals.push(toSignal(ts, repoRoot, diagnostic));
      }
    }
  }

  return signals;
}

export function toRepoAbsolutePath(repoRoot: string, fileName: string): string {
  return isAbsolute(fileName) ? resolve(fileName) : resolve(repoRoot, fileName);
}

function toSignal(ts: typeof TS, repoRoot: string, diagnostic: TS.Diagnostic): AnalyzerSignal {
  const file = diagnostic.file as TS.SourceFile;
  const absolutePath = toRepoAbsolutePath(repoRoot, file.fileName);
  const path = relative(repoRoot, absolutePath) || file.fileName;
  const start = diagnostic.start ?? 0;
  const startPos = file.getLineAndCharacterOfPosition(start);
  const endPos = file.getLineAndCharacterOfPosition(start + (diagnostic.length ?? 0));
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

  return {
    id: `typescript:TS${diagnostic.code}:${path}:${startPos.line + 1}`,
    analyzer: "typescript",
    ruleId: `typescript.TS${diagnostic.code}`,
    range: {
      file: path,
      startLine: startPos.line + 1,
      endLine: Math.max(startPos.line + 1, endPos.line + 1),
      startColumn: startPos.character + 1,
      endColumn: endPos.character + 1,
      diffSide: "right"
    },
    severity: severityFor(ts, diagnostic.category),
    message,
    evidence: [`tsc TS${diagnostic.code}`]
  };
}

function severityFor(ts: typeof TS, category: TS.DiagnosticCategory): Severity {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "high";
    case ts.DiagnosticCategory.Warning:
      return "medium";
    case ts.DiagnosticCategory.Suggestion:
      return "low";
    default:
      return "info";
  }
}
