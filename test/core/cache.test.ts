import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { homedir } from "node:os";
import { parse } from "node:path";
import { assertSafeCacheDir, cacheDirStats, cacheKey, createFileCache, createNoopCache, defaultCacheDir, globalCacheDir, repoLocalCacheDir } from "../../src/core/cache.js";
import { runAnalyzers } from "../../src/core/analyze.js";
import { withLlmCache } from "../../src/core/llm-cache.js";
import { registerAnalyzerProvider } from "../../src/providers/analyzers/registry.js";
import type { AnalyzerContext, AnalyzerProvider, LLMProvider } from "../../src/types/providers.js";
import type { Cache } from "../../src/core/cache.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hubolt-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createFileCache", () => {
  test("round-trips a value and tracks hits/misses", () => {
    const cache = createFileCache(dir);
    expect(cache.get("k")).toBeNull();
    cache.set("k", { a: 1 });
    expect(cache.get<{ a: number }>("k")).toEqual({ a: 1 });
    expect(cache.stats()).toEqual({ hits: 1, misses: 1 });
  });

  test("cacheKey is stable and order-sensitive", () => {
    expect(cacheKey(["a", 1])).toBe(cacheKey(["a", 1]));
    expect(cacheKey(["a", 1])).not.toBe(cacheKey([1, "a"]));
  });

  test("cacheKey does not collide on shifted part boundaries", () => {
    // ["foo", "bar baz"] vs ["foo bar", "baz"] would collide with a bare separator.
    expect(cacheKey(["foo", "bar baz"])).not.toBe(cacheKey(["foo bar", "baz"]));
    expect(cacheKey(["a", "b"])).not.toBe(cacheKey(["a b"]));
  });

  test("defaultCacheDir is repo-scoped under the global Hubolt cache", () => {
    const first = defaultCacheDir(join(dir, "repo-a"));
    const second = defaultCacheDir(join(dir, "repo-b"));

    expect(first.startsWith(globalCacheDir())).toBe(true);
    expect(second.startsWith(globalCacheDir())).toBe(true);
    expect(first).not.toBe(second);
  });

  test("cacheDirStats counts json entries", () => {
    createFileCache(dir).set("x", { v: 1 });
    expect(cacheDirStats(dir).entries).toBe(1);
  });

  test("does not read cache entries through symlinks", () => {
    if (process.platform === "win32") {
      return;
    }
    const target = join(dir, "external.json");
    writeFileSync(target, JSON.stringify({ a: 1 }));
    symlinkSync(target, join(dir, "linked.json"));

    expect(createFileCache(dir).get("linked")).toBeNull();
  });

  test("does not overwrite symlink targets when writing cache entries", () => {
    if (process.platform === "win32") {
      return;
    }
    const target = join(dir, "external.txt");
    writeFileSync(target, "keep");
    symlinkSync(target, join(dir, "linked.json"));

    const cache = createFileCache(dir);
    cache.set("linked", { a: 1 });

    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(cache.get("linked")).toEqual({ a: 1 });
  });

  test("cacheDirStats skips broken symlinks", () => {
    if (process.platform === "win32") {
      return;
    }
    symlinkSync(join(dir, "missing-target"), join(dir, "broken.json"));

    expect(cacheDirStats(dir)).toEqual({ entries: 0, bytes: 0 });
  });

  test("cacheDirStats skips directory symlink cycles", () => {
    if (process.platform === "win32") {
      return;
    }
    const nested = join(dir, "nested");
    mkdirSync(nested);
    createFileCache(nested).set("x", { v: 1 });
    symlinkSync(dir, join(nested, "cycle"));

    expect(cacheDirStats(dir).entries).toBe(1);
  });

  test("does not read or write through a symlinked cache directory", () => {
    if (process.platform === "win32") {
      return; // symlink creation needs elevated privileges on Windows
    }
    const target = mkdtempSync(join(tmpdir(), "hubolt-target-"));
    const linkedDir = join(dir, "analyzers");
    try {
      symlinkSync(target, linkedDir);
      const cache = createFileCache(linkedDir);
      cache.set("abc123", { a: 1 });
      expect(existsSync(join(target, "abc123.json"))).toBe(false);
      expect(cache.get("abc123")).toBeNull();
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("noop cache stores nothing", () => {
    const cache = createNoopCache();
    cache.set("k", 1);
    expect(cache.get("k")).toBeNull();
  });

  test("assertSafeCacheDir rejects root, home, cwd, ancestors, and unrelated dirs", () => {
    expect(() => assertSafeCacheDir(parse(process.cwd()).root, { repoRoot: dir })).toThrow();
    expect(() => assertSafeCacheDir(homedir(), { repoRoot: dir })).toThrow();
    expect(() => assertSafeCacheDir(process.cwd(), { repoRoot: dir })).toThrow();
    expect(() => assertSafeCacheDir(join(process.cwd(), ".."), { repoRoot: dir })).toThrow();
    expect(() => assertSafeCacheDir(join(tmpdir(), "important-external-dir"), { repoRoot: dir })).toThrow();
  });

  test("assertSafeCacheDir rejects unsafe env-style cache roots before writes", () => {
    const unsafeRoot = join(tmpdir(), "malicious-cache-root");

    expect(() => assertSafeCacheDir(unsafeRoot, { repoRoot: dir })).toThrow(/unsafe path/);
  });

  test("assertSafeCacheDir allows explicit repo-local and global Hubolt cache trees", () => {
    const repoCache = repoLocalCacheDir(dir);
    const nestedRepoCache = join(repoCache, "llm");
    const globalCache = defaultCacheDir(dir);
    const nestedGlobalCache = join(globalCache, "repo-key");

    expect(assertSafeCacheDir(repoCache, { repoRoot: dir })).toBe(repoCache);
    expect(assertSafeCacheDir(nestedRepoCache, { repoRoot: dir })).toBe(nestedRepoCache);
    expect(assertSafeCacheDir(globalCache, { repoRoot: dir })).toBe(globalCache);
    expect(assertSafeCacheDir(nestedGlobalCache, { repoRoot: dir })).toBe(nestedGlobalCache);
  });

  test("assertSafeCacheDir compares path casing according to the platform", () => {
    const mixedCaseRepoCache = join(dir, ".HUBOLT", "CACHE");

    if (process.platform === "darwin" || process.platform === "win32") {
      expect(assertSafeCacheDir(mixedCaseRepoCache, { repoRoot: dir })).toBe(mixedCaseRepoCache);
    } else {
      expect(() => assertSafeCacheDir(mixedCaseRepoCache, { repoRoot: dir })).toThrow();
    }
  });

  test("rejects a broken (dangling) symlink at the cache path", () => {
    if (process.platform === "win32") {
      return;
    }
    const repo = mkdtempSync(join(tmpdir(), "hubolt-repo-"));
    try {
      mkdirSync(join(repo, ".hubolt"));
      // Target does not exist: realpath fails and canonicalize falls back to a
      // literal path, which previously passed containment.
      symlinkSync(join(tmpdir(), `hubolt-missing-${Date.now()}`), join(repo, ".hubolt", "cache"));
      expect(() => assertSafeCacheDir(join(repo, ".hubolt", "cache"), { repoRoot: repo })).toThrow(/unsafe path/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("rejects a repo .hubolt/cache that is a symlink pointing outside the repo", () => {
    if (process.platform === "win32") {
      return; // symlink creation needs elevated privileges on Windows
    }
    const repo = mkdtempSync(join(tmpdir(), "hubolt-repo-"));
    const external = mkdtempSync(join(tmpdir(), "hubolt-external-"));
    try {
      mkdirSync(join(repo, ".hubolt"));
      symlinkSync(external, join(repo, ".hubolt", "cache"));
      // The symlinked cache resolves outside the repo, so it must be refused even
      // though it sits at the .hubolt/cache path the guard otherwise allows.
      expect(() => assertSafeCacheDir(join(repo, ".hubolt", "cache"), { repoRoot: repo })).toThrow(/unsafe path/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  test("rejects a symlink that resolves to cwd (canonicalization)", () => {
    if (process.platform === "win32") {
      return; // symlink creation needs elevated privileges on Windows
    }
    const link = join(dir, "link-to-cwd");
    symlinkSync(process.cwd(), link);
    expect(() => assertSafeCacheDir(link, { repoRoot: dir })).toThrow();
  });

  test("rejects non-existent descendants under an intermediate symlink", () => {
    if (process.platform === "win32") {
      return;
    }
    const repoCache = repoLocalCacheDir(dir);
    mkdirSync(repoCache, { recursive: true });
    const link = join(repoCache, "link-to-tmp");
    symlinkSync(tmpdir(), link);

    expect(() => assertSafeCacheDir(join(link, "missing-child"), { repoRoot: dir })).toThrow();
  });
});

describe("analyzer cache reuse", () => {
  test("a second run with the same inputs does not re-invoke the analyzer", async () => {
    let calls = 0;
    const counting: AnalyzerProvider = {
      name: "counting",
      async isAvailable() {
        return true;
      },
      async analyze(ctx: AnalyzerContext) {
        calls += 1;
        return [
          {
            id: "counting:x:src/a.ts:1",
            analyzer: "counting",
            ruleId: "counting.x",
            range: { file: "src/a.ts", startLine: 1, endLine: 1, diffSide: "right" as const },
            severity: "low" as const,
            message: "m",
            evidence: []
          }
        ];
      }
    };
    registerAnalyzerProvider("counting", () => counting);

    const ctx = {
      repoRoot: "/tmp/repo",
      config: { mode: "balanced" } as never,
      files: [{ path: "src/a.ts", status: "modified" as const, content: "x", changedRanges: [] }]
    };
    const cache = createFileCache(dir);

    const first = await runAnalyzers(ctx, ["counting"], { cache });
    const second = await runAnalyzers(ctx, ["counting"], { cache });

    expect(calls).toBe(1);
    expect(first.signals).toHaveLength(1);
    expect(second.signals).toHaveLength(1);
    expect(second.ran).toEqual(["counting"]);
  });

  test("invalid cached analyzer data is treated as a miss", async () => {
    let calls = 0;
    const counting: AnalyzerProvider = {
      name: "counting-invalid-cache",
      async isAvailable() {
        return true;
      },
      async analyze() {
        calls += 1;
        return [];
      }
    };
    registerAnalyzerProvider("counting-invalid-cache", () => counting);
    const cache = invalidReadCache();
    const ctx = {
      repoRoot: "/tmp/repo",
      config: { mode: "balanced" } as never,
      files: [{ path: "src/a.ts", status: "modified" as const, content: "x", changedRanges: [] }]
    };

    const result = await runAnalyzers(ctx, ["counting-invalid-cache"], { cache });

    expect(calls).toBe(1);
    expect(result.ran).toEqual(["counting-invalid-cache"]);
  });
});

describe("withLlmCache", () => {
  test("reuses cached findings for an identical request", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      name: "fake",
      async review() {
        calls += 1;
        return [];
      }
    };
    const cached = withLlmCache(provider, createFileCache(dir), "model-x");
    const request = { system: "sys", user: "usr" };

    await cached.review(request);
    await cached.review(request);

    expect(calls).toBe(1);
  });

  test("normalizes random prompt boundaries when building cache keys", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      name: "fake",
      async review() {
        calls += 1;
        return [];
      }
    };
    const cached = withLlmCache(provider, createFileCache(dir), "model-x");

    await cached.review({
      system: 'Boundary is "END_UNTRUSTED_aaaaaaaaaaaaaaaaaa".',
      user: "BEGIN_UNTRUSTED_aaaaaaaaaaaaaaaaaa\nconst x = 1;\nEND_UNTRUSTED_aaaaaaaaaaaaaaaaaa"
    });
    await cached.review({
      system: 'Boundary is "END_UNTRUSTED_bbbbbbbbbbbbbbbbbb".',
      user: "BEGIN_UNTRUSTED_bbbbbbbbbbbbbbbbbb\nconst x = 1;\nEND_UNTRUSTED_bbbbbbbbbbbbbbbbbb"
    });

    expect(calls).toBe(1);
  });

  test("invalid cached LLM data is treated as a miss", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      name: "fake",
      async review() {
        calls += 1;
        return [];
      }
    };
    const cached = withLlmCache(provider, invalidReadCache(), "model-x");

    await cached.review({ system: "sys", user: "usr" });

    expect(calls).toBe(1);
  });

  test("does not crash when a runtime caller omits prompt fields", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      name: "fake",
      async review() {
        calls += 1;
        return [];
      }
    };
    const cached = withLlmCache(provider, createFileCache(dir), "model-x");

    await cached.review({} as never);

    expect(calls).toBe(1);
  });
});

function invalidReadCache(): Cache {
  return {
    get<T>() {
      return { bad: true } as T;
    },
    set() {
      /* no-op */
    },
    stats() {
      return { hits: 0, misses: 0 };
    }
  };
}
