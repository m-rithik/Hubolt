import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

/**
 * Build a stable cache key by hashing the given parts. Each part is length-framed
 * (byte length + ":" + value) so part boundaries are unambiguous; a bare
 * separator would let ["a","b"] and ["a b"] collide, which matters because file
 * paths and contents contain spaces.
 */
export function cacheKey(parts: Array<string | number>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = String(part);
    hash.update(`${Buffer.byteLength(value)}:`);
    hash.update(value);
  }
  return hash.digest("hex");
}

export interface CacheStats {
  hits: number;
  misses: number;
}

export interface Cache {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
  stats(): CacheStats;
}

/** Designated user-level cache location for explicitly global cache use. */
export function globalCacheDir(): string {
  return join(homedir(), ".hubolt", "cache");
}

/** Repo-local cache path allowed only when explicitly configured by the user. */
export function repoLocalCacheDir(repoRoot: string): string {
  return join(repoRoot, ".hubolt", "cache");
}

/** Default on-disk cache location for a repository. */
export function defaultCacheDir(repoRoot: string): string {
  return join(globalCacheDir(), "repos", cacheKey([repoRoot]).slice(0, 16));
}

/**
 * Resolve a path to its canonical form, including symlinks in existing parent
 * directories. If the target does not exist yet, resolve the longest existing
 * ancestor and append the missing suffix. This prevents a path like
 * allowed/link-to-tmp/new-dir from passing containment checks merely because the
 * final leaf does not exist.
 */
function canonicalize(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    let existing = absolute;
    const missing: string[] = [];

    while (true) {
      const parent = dirname(existing);
      if (parent === existing) {
        return absolute;
      }
      missing.unshift(relative(parent, existing));
      existing = parent;
      try {
        return resolve(realpathSync.native(existing), ...missing);
      } catch {
        // Keep walking upward until an existing ancestor can be resolved.
      }
    }
  }
}

/**
 * Guard a cache directory before a destructive operation (clear/restore). The
 * cache path can come from HUBOLT_CACHE_DIR, but recursive operations are only
 * allowed inside an explicitly configured repo-local .hubolt/cache tree or
 * Hubolt's designated global cache tree under the user's home directory. Paths
 * are canonicalized first so case variants and symlinks cannot bypass the
 * containment check.
 */
export function assertSafeCacheDir(dir: string, options: { repoRoot?: string } = {}): string {
  const resolved = resolve(dir);
  const canonical = canonicalize(resolved);
  const home = canonicalize(homedir());
  // Build the allowed roots from canonicalized *base* directories (the trusted
  // repo root and home) with a literal ".hubolt/cache" appended. Canonicalizing
  // the full .hubolt/cache path instead would follow a symlink planted at that
  // leaf, so the symlink target would validate as "inside" itself. The candidate
  // path is still canonicalized, so a symlinked cache dir resolves to its target
  // and is correctly refused for being outside these roots.
  const repoBase = canonicalize(options.repoRoot ?? process.cwd());
  const repoCache = join(repoBase, ".hubolt", "cache");
  const globalCache = join(home, ".hubolt", "cache");
  const withinRepo = isWithin(canonical, repoCache);
  const withinGlobal = isWithin(canonical, globalCache);

  const fail = (): Error =>
    new Error(
      `Refusing to use an unsafe path for the cache: ${resolved}. The cache must live inside ` +
        `.hubolt/cache (repo) or ~/.hubolt/cache; set HUBOLT_CACHE_DIR within one of those, or pass --no-cache.`
    );

  if (canonical === parse(canonical).root || canonical === home || (!withinRepo && !withinGlobal)) {
    throw fail();
  }

  // canonicalize() falls back to a literal path when realpath fails on a *broken*
  // symlink, so a dangling .hubolt/cache link would pass containment while the
  // real write follows it outside. Reject any symlinked segment below the trusted
  // base (the attacker-controllable region) to close that bypass.
  if (hasSymlinkSegmentBelow(withinRepo ? repoBase : home, canonical)) {
    throw fail();
  }

  return resolved;
}

/**
 * Walk each path segment from `base` down to `target` and report whether any
 * existing segment is a symbolic link. Segments above `base` (e.g. system paths
 * like /var on macOS) are trusted and not inspected.
 */
function hasSymlinkSegmentBelow(base: string, target: string): boolean {
  const rel = relative(base, target);
  if (!rel || rel.startsWith("..")) {
    return false;
  }

  let current = base;
  for (const segment of rel.split(sep)) {
    if (!segment) {
      continue;
    }
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return true;
      }
    } catch {
      return false; // segment does not exist yet; nothing below it can be a planted link
    }
  }
  return false;
}

function isWithin(path: string, root: string): boolean {
  const comparablePath = normalizePathForComparison(path);
  const comparableRoot = normalizePathForComparison(root);
  return comparablePath === comparableRoot || comparablePath.startsWith(comparableRoot + sep);
}

function normalizePathForComparison(path: string): string {
  return process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;
}

/**
 * Content-addressed JSON cache on disk. One file per key. All disk operations
 * are best-effort: a read miss or a write failure never throws, so caching can
 * never break a review.
 */
export function createFileCache(dir: string): Cache {
  let hits = 0;
  let misses = 0;

  return {
    get<T>(key: string): T | null {
      try {
        const path = cacheEntryPath(dir, key);
        if (!path || isSymlink(dir) || isSymlink(path)) {
          throw new Error("Unsafe cache entry path");
        }
        const value = JSON.parse(readFileSync(path, "utf8")) as T;
        hits += 1;
        return value;
      } catch {
        misses += 1;
        return null;
      }
    },
    set<T>(key: string, value: T): void {
      try {
        const path = cacheEntryPath(dir, key);
        // Refuse to write through a symlinked cache directory: a planted
        // .hubolt/cache/<sub> symlink would otherwise redirect writes outside
        // the cache (the directory root is already containment-checked).
        if (!path || isSymlink(dir)) {
          return;
        }
        mkdirSync(dir, { recursive: true });
        const temp = join(dir, `.${key}.${process.pid}.${Date.now()}.tmp`);
        writeFileSync(temp, JSON.stringify(value));
        renameSync(temp, path);
      } catch {
        // Cache writes are non-fatal.
      }
    },
    stats(): CacheStats {
      return { hits, misses };
    }
  };
}

function cacheEntryPath(dir: string, key: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(key) || key.includes("..")) {
    return null;
  }
  return join(dir, `${key}.json`);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A cache that never stores anything; used when caching is disabled. */
export function createNoopCache(): Cache {
  return {
    get() {
      return null;
    },
    set() {
      /* no-op */
    },
    stats() {
      return { hits: 0, misses: 0 };
    }
  };
}

export interface CacheDirStats {
  entries: number;
  bytes: number;
}

/** Count cache entries and total bytes under a directory tree. */
export function cacheDirStats(dir: string): CacheDirStats {
  let entries = 0;
  let bytes = 0;

  const walk = (current: string): void => {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(current, name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (name.endsWith(".json")) {
        entries += 1;
        bytes += stat.size;
      }
    }
  };

  walk(dir);
  return { entries, bytes };
}
