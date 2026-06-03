import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { DEFAULT_CONFIG_FILE } from "./defaults.js";
import { RepoConfigSchema, type RepoConfig } from "./schema.js";

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

  return {
    config: RepoConfigSchema.parse(parsed),
    path: configPath
  };
}

export function validateRepoConfig(options: LoadRepoConfigOptions = {}): LoadedRepoConfig {
  return loadRepoConfig(options);
}
