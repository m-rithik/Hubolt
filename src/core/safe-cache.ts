import { writeFileSync, readFileSync, renameSync, unlinkSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { CacheValidators, PathValidators } from "./validators.js";

export interface CacheOptions {
  maxEntrySize?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_ENTRY_SIZE = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

export class SafeCache {
  private maxEntrySize: number;
  private timeoutMs: number;

  constructor(private baseDir: string, options: CacheOptions = {}) {
    this.maxEntrySize = options.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    PathValidators.validatePathWithin(baseDir, process.cwd());
  }

  set<T>(key: string, value: T): void {
    CacheValidators.validateCacheKey(key);

    const json = JSON.stringify(value);
    if (json.length > this.maxEntrySize) {
      throw new Error(
        `Cache entry too large: ${json.length} bytes exceeds limit of ${this.maxEntrySize} bytes`
      );
    }

    const path = join(this.baseDir, CacheValidators.sanitizeCacheKey(key) + ".json");
    PathValidators.validatePathWithin(path, this.baseDir);

    const tempDir = mkdtempSync(join(this.baseDir, ".cache-tmp-"));
    const tempFile = join(tempDir, "data.json");

    try {
      writeFileSync(tempFile, json, "utf8");
      renameSync(tempFile, path);
    } catch (error) {
      try {
        unlinkSync(tempFile);
      } catch {}
      throw error;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  get<T>(key: string): T | null {
    CacheValidators.validateCacheKey(key);

    const path = join(this.baseDir, CacheValidators.sanitizeCacheKey(key) + ".json");
    PathValidators.validatePathWithin(path, this.baseDir);

    try {
      const data = readFileSync(path, "utf8");
      if (data.length > this.maxEntrySize) {
        return null;
      }
      return JSON.parse(data) as T;
    } catch (error) {
      return null;
    }
  }

  has(key: string): boolean {
    try {
      CacheValidators.validateCacheKey(key);
      const path = join(this.baseDir, CacheValidators.sanitizeCacheKey(key) + ".json");
      PathValidators.validatePathWithin(path, this.baseDir);
      readFileSync(path, "utf8");
      return true;
    } catch {
      return false;
    }
  }
}

export function generateUniqueTempFileName(prefix = ""): string {
  const random = randomBytes(16).toString("hex");
  const timestamp = Date.now();
  return `${prefix}${timestamp}-${random}.tmp`;
}
