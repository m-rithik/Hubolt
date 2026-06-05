import { cpSync, existsSync, rmSync } from "node:fs";
import type { Command } from "commander";
import { resolveSettings } from "../../config/resolve.js";
import { assertSafeCacheDir, cacheDirStats, defaultCacheDir } from "../../core/cache.js";
import { getGitRoot, isGitRepository } from "../../core/git.js";
import { runSafely } from "../errors.js";
import { ui } from "../ui.js";

interface SaveOptions {
  to: string;
  config?: string;
}
interface RestoreOptions {
  from: string;
  config?: string;
}
interface CacheOptions {
  config?: string;
}
interface CacheTarget {
  dir: string;
  repo: string;
}

function resolveCacheTarget(configPath?: string): CacheTarget {
  const repo = isGitRepository() ? getGitRoot() : process.cwd();
  const settings = resolveSettings({ cwd: configPath ? process.cwd() : repo, configPath });
  return { dir: settings.cacheDir ?? defaultCacheDir(repo), repo };
}

export function registerCacheCommand(program: Command): void {
  const cache = program
    .command("cache")
    .description("Inspect and manage the local review result cache.")
    .option("-c, --config <path>", "path to a Hubolt config file");

  cache
    .command("status", { isDefault: true })
    .description("Show cache location, entry count, and size.")
    .option("-c, --config <path>", "path to a Hubolt config file")
    .action((options: CacheOptions, command: Command) => runSafely(() => showStatus(resolveConfigPath(options, command))));

  cache
    .command("clear")
    .description("Delete all cached results.")
    .option("-c, --config <path>", "path to a Hubolt config file")
    .action((options: CacheOptions, command: Command) =>
      runSafely(() => {
        const target = resolveCacheTarget(resolveConfigPath(options, command));
        const dir = assertSafeCacheDir(target.dir, { repoRoot: target.repo });
        rmSync(dir, { recursive: true, force: true });
        console.log(ui.success(`Cleared cache at ${dir}.`));
      })
    );

  cache
    .command("save")
    .description("Copy the local cache to an external directory (for CI persistence).")
    .requiredOption("--to <dir>", "destination directory")
    .option("-c, --config <path>", "path to a Hubolt config file")
    .action((options: SaveOptions, command: Command) =>
      runSafely(() => {
        const target = resolveCacheTarget(resolveConfigPath(options, command));
        const dir = assertSafeCacheDir(target.dir, { repoRoot: target.repo });
        if (!existsSync(dir)) {
          console.log(ui.muted("No cache to save."));
          return;
        }
        cpSync(dir, options.to, { recursive: true });
        const stats = cacheDirStats(dir);
        console.log(ui.success(`Saved ${stats.entries} cache entr${stats.entries === 1 ? "y" : "ies"} to ${options.to}.`));
      })
    );

  cache
    .command("restore")
    .description("Copy a cache from an external directory into the local cache.")
    .requiredOption("--from <dir>", "source directory")
    .option("-c, --config <path>", "path to a Hubolt config file")
    .action((options: RestoreOptions, command: Command) =>
      runSafely(() => {
        if (!existsSync(options.from)) {
          console.log(ui.muted(`No cache found at ${options.from}.`));
          return;
        }
        const target = resolveCacheTarget(resolveConfigPath(options, command));
        const dir = assertSafeCacheDir(target.dir, { repoRoot: target.repo });
        cpSync(options.from, dir, { recursive: true });
        const stats = cacheDirStats(dir);
        console.log(ui.success(`Restored ${stats.entries} cache entr${stats.entries === 1 ? "y" : "ies"} to ${dir}.`));
      })
    );
}

function resolveConfigPath(options: CacheOptions, command: Command): string | undefined {
  const parentOptions = command.parent?.opts<CacheOptions>();
  return options.config ?? parentOptions?.config;
}

function showStatus(configPath?: string): void {
  const target = resolveCacheTarget(configPath);
  const dir = assertSafeCacheDir(target.dir, { repoRoot: target.repo });
  const stats = cacheDirStats(dir);
  console.log(
    ui.section("Hubolt Cache", [
      ["Location", dir],
      ["Entries", String(stats.entries)],
      ["Size", formatBytes(stats.bytes)]
    ])
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
