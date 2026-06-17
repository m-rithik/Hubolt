import { Worker } from "node:worker_threads";
import type * as TS from "typescript";
import type { AnalyzerSignal } from "../../types/finding.js";
import type { AnalyzerContext, AnalyzerProvider } from "../../types/providers.js";
import { runTypeScriptDiagnostics, toRepoAbsolutePath } from "./typescript-core.js";

export { toRepoAbsolutePath };

/**
 * TypeScript compiler-API analyzer. Reports diagnostics on changed files.
 * Degrades to unavailable (not an error) when typescript or a tsconfig is
 * missing.
 *
 * The analysis (createProgram + type-check) is synchronous and CPU-heavy, so
 * it runs in a worker thread to keep the main thread - and its progress
 * spinner - responsive. If the worker cannot start (for example when running
 * from .ts sources without a built worker file), it falls back to running the
 * same analysis inline; results are identical, only the spinner pauses.
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
      if (!ts.findConfigFile(ctx.repoRoot, ts.sys.fileExists, "tsconfig.json")) {
        return [];
      }

      const changedPaths = ctx.files.map((file) => file.path);
      try {
        return await analyzeInWorker(ctx.repoRoot, changedPaths);
      } catch {
        // No worker available: run inline. Correct, but blocks the main thread.
        return runTypeScriptDiagnostics(ts, ctx.repoRoot, changedPaths);
      }
    }
  };
}

interface WorkerResult {
  signals?: AnalyzerSignal[];
  error?: string;
}

function analyzeInWorker(repoRoot: string, changedPaths: string[]): Promise<AnalyzerSignal[]> {
  return new Promise<AnalyzerSignal[]>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./typescript-worker.js", import.meta.url), {
        workerData: { repoRoot, changedPaths }
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      void worker.terminate();
      action();
    };

    worker.once("message", (message: WorkerResult) => {
      if (message.error) {
        finish(() => reject(new Error(message.error)));
      } else {
        finish(() => resolve(message.signals ?? []));
      }
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      // Settle on any unsettled exit, including a clean (code 0) exit that
      // never posted a result. Otherwise the await would hang forever; the
      // caller falls back to inline analysis instead.
      if (!settled) {
        finish(() => reject(new Error(`typescript worker exited without a result (code ${code})`)));
      }
    });
  });
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
