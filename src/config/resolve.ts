import { loadEnv, type HuboltEnv } from "./env.js";
import { loadRepoConfig } from "./repo-config.js";
import type { RepoConfig } from "./schema.js";

export interface ResolvedSettings {
  configPath: string | null;
  mode: RepoConfig["mode"];
  llmProvider: string;
  llmModel: string;
  reviewConcurrency?: number;
  cacheDir?: string;
  repo: RepoConfig;
}

export interface ResolveSettingsOptions {
  cwd?: string;
  configPath?: string;
  env?: HuboltEnv;
}

/**
 * Resolve effective settings with precedence: defaults < .hubolt.yml < environment.
 * CLI flags are applied by callers on top of the result.
 */
export function resolveSettings(options: ResolveSettingsOptions = {}): ResolvedSettings {
  const loaded = loadRepoConfig({ cwd: options.cwd, configPath: options.configPath });
  const env = options.env ?? loadEnv();

  return {
    configPath: loaded.path,
    mode: loaded.config.mode,
    llmProvider: env.llmProvider ?? loaded.config.providers.llm,
    llmModel: env.llmModel ?? loaded.config.providers.model,
    reviewConcurrency: env.reviewConcurrency,
    cacheDir: env.cacheDir,
    repo: loaded.config
  };
}
