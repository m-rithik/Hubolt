import { parentPort, workerData } from "node:worker_threads";
import type * as TS from "typescript";
import { runTypeScriptDiagnostics } from "./typescript-core.js";

/**
 * Worker entry: runs the blocking TypeScript analysis off the main thread so a
 * progress spinner on the main thread keeps animating. Posts back the signals
 * (plain, structured-cloneable objects) or an error string.
 */
async function main(): Promise<void> {
  const { repoRoot, changedPaths } = workerData as { repoRoot: string; changedPaths: string[] };
  try {
    const imported = (await import("typescript")) as { default?: typeof TS } & typeof TS;
    const ts = imported.default ?? imported;
    const signals = runTypeScriptDiagnostics(ts, repoRoot, changedPaths);
    parentPort?.postMessage({ signals });
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : "typescript worker failed" });
  }
}

void main();
