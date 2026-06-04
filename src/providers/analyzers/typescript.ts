import { dirname, isAbsolute, relative, resolve } from "node:path";
import type * as TS from "typescript";
import type { AnalyzerSignal, Severity } from "../../types/finding.js";
import type { AnalyzerContext, AnalyzerProvider } from "../../types/providers.js";

/**
 * TypeScript compiler-API analyzer. Builds a program from the repository
 * tsconfig and reports pre-emit diagnostics that fall on changed files. Degrades
 * to unavailable (not an error) when typescript or a tsconfig is missing.
 */
export function makeTypeScriptAnalyzer(): AnalyzerProvider {
  return {
    name: "typescript",
    async isAvailable(ctx: AnalyzerContext): Promise<boolean> {
      const ts = await loadTypeScript();
      if (!ts) {
        return false;
      }
      return Boolean(ts.findConfigFile(ctx.repoRoot, ts.sys.fileExists, "tsconfig.json"));
    },
    async analyze(ctx: AnalyzerContext): Promise<AnalyzerSignal[]> {
      const ts = await loadTypeScript();
      if (!ts) {
        return [];
      }

      const configPath = ts.findConfigFile(ctx.repoRoot, ts.sys.fileExists, "tsconfig.json");
      if (!configPath) {
        return [];
      }

      const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(configFile.config ?? {}, ts.sys, dirname(configPath));
      const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });

      const changed = new Set(ctx.files.map((file) => toRepoAbsolutePath(ctx.repoRoot, file.path)));
      const signals: AnalyzerSignal[] = [];

      for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
        if (!diagnostic.file || !changed.has(toRepoAbsolutePath(ctx.repoRoot, diagnostic.file.fileName))) {
          continue;
        }
        signals.push(toSignal(ts, ctx.repoRoot, diagnostic));
      }

      return signals;
    }
  };
}

let typeScriptModule: typeof TS | null | undefined;

async function loadTypeScript(): Promise<typeof TS | null> {
  if (typeScriptModule !== undefined) {
    return typeScriptModule;
  }
  try {
    const imported = (await import("typescript")) as { default?: typeof TS } & typeof TS;
    typeScriptModule = imported.default ?? imported;
  } catch {
    typeScriptModule = null;
  }
  return typeScriptModule;
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

export function toRepoAbsolutePath(repoRoot: string, fileName: string): string {
  return isAbsolute(fileName) ? resolve(fileName) : resolve(repoRoot, fileName);
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
