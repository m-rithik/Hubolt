import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SafeCache } from "../../src/core/safe-cache.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(process.cwd(), ".safe-cache-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SafeCache", () => {
  test("cleans up temporary directories after writes", () => {
    const cache = new SafeCache(dir);

    cache.set("first", { ok: true });
    cache.set("second", { ok: true });

    expect(readdirSync(dir).filter((entry) => entry.startsWith(".cache-tmp-"))).toEqual([]);
  });
});
