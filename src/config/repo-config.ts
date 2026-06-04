import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { DEFAULT_CONFIG_FILE } from "./defaults.js";
import { REPO_CONFIG_TOP_LEVEL_KEYS, RepoConfigSchema, type RepoConfig } from "./schema.js";

export interface LoadRepoConfigOptions {
  cwd?: string;
  configPath?: string;
}

export interface LoadedRepoConfig {
  config: RepoConfig;
  path: string | null;
}

export function loadRepoConfig(options: LoadRepoConfigOptions = {}): LoadedRepoConfig {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolve(cwd, options.configPath ?? DEFAULT_CONFIG_FILE);

  if (!existsSync(configPath)) {
    return {
      config: RepoConfigSchema.parse({}),
      path: null
    };
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = parse(raw) ?? {};

  warnUnknownKeys(parsed, configPath);

  return {
    config: RepoConfigSchema.parse(parsed),
    path: configPath
  };
}

/**
 * Warn (without failing) about top-level config keys the schema does not model.
 * Zod strips unknown keys silently, so a typo like `severityThreshhold` would
 * otherwise validate and do nothing. We warn rather than error to stay
 * forward-compatible as new keys are added.
 */
function warnUnknownKeys(parsed: unknown, configPath: string): void {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return;
  }

  const known = new Set(REPO_CONFIG_TOP_LEVEL_KEYS);
  const unknown = Object.keys(parsed as Record<string, unknown>).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    console.warn(`Hubolt: ignoring unknown config key(s) in ${configPath}: ${unknown.join(", ")}`);
  }
}

export function validateRepoConfig(options: LoadRepoConfigOptions = {}): LoadedRepoConfig {
  return loadRepoConfig(options);
}
