import { readFileSync } from "node:fs";

/**
 * Single source of truth for the package version, read from package.json so the
 * CLI banner and generated reports never drift from the published version.
 * Both src/version.ts and the compiled dist/version.js sit one level below the
 * package root, so "../package.json" resolves the same in dev (tsx), in the
 * build output, and in the published package.
 */
export const HUBOLT_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;
