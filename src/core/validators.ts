import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

export const RangeValidators = {
  isValidLineRange(startLine: number, endLine: number): boolean {
    return startLine > 0 && endLine > 0 && endLine >= startLine;
  },

  validateLineRange(startLine: number, endLine: number): void {
    if (!this.isValidLineRange(startLine, endLine)) {
      throw new Error(`Invalid line range: startLine=${startLine}, endLine=${endLine}`);
    }
  },

  refineLineRange() {
    return (range: { startLine: number; endLine: number }) =>
      this.isValidLineRange(range.startLine, range.endLine);
  },

  lineRangeMessage() {
    return "startLine and endLine must be positive, with endLine >= startLine";
  }
};

export const PatternValidators = {
  API_KEY_PATTERNS: [
    /\b(?:api[_-]?key|apikey)\b/gi,
    /\b(?:api[_-]?secret|apisecret)\b/gi,
    /\b(?:access[_-]?key|accesskey)\b/gi,
    /\b(?:private[_-]?key|privatekey)\b/gi,
    /\b(?:auth[_-]?token|authtoken)\b/gi,
    /\b(?:credentials?|creds?)\b/gi
  ],

  JWT_PATTERNS: [
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g
  ],

  ENV_VAR_PATTERNS: [
    /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b/g,
    /\b[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*\b/g
  ]
};

export const SchemaValidators = {
  createSafeEnvSchema() {
    return z
      .object({
        API_KEY: z.string().min(8).optional(),
        API_SECRET: z.string().min(8).optional(),
        AUTH_TOKEN: z.string().min(10).optional(),
        PRIVATE_KEY: z.string().optional(),
        DATABASE_URL: z.string().url().optional(),
        CONNECTION_STRING: z.string().optional()
      })
      .strict();
  },

  validateEnvVarName(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  }
};

export const CacheValidators = {
  isValidCacheKey(key: string): boolean {
    return /^[a-zA-Z0-9._\-]+$/.test(key) && key.length > 0 && key.length <= 256;
  },

  validateCacheKey(key: string): void {
    if (!this.isValidCacheKey(key)) {
      throw new Error(
        `Invalid cache key: "${key}". Must match /^[a-zA-Z0-9._\\-]+$/ and be 1-256 chars`
      );
    }
  },

  sanitizeCacheKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9._\-]/g, "_").substring(0, 256);
  }
};

export const PathValidators = {
  isPathWithin(filePath: string, baseDir: string): boolean {
    try {
      const normalized = resolve(filePath);
      const normalizedBase = resolve(baseDir);
      const relativePath = relative(normalizedBase, normalized);
      return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
    } catch {
      return false;
    }
  },

  validatePathWithin(filePath: string, baseDir: string): void {
    if (!this.isPathWithin(filePath, baseDir)) {
      throw new Error(`Path escape attempt: "${filePath}" is outside "${baseDir}"`);
    }
  }
};

export const GithubValidators = {
  isValidGitRef(ref: string): boolean {
    return /^[a-zA-Z0-9._\/\-]+$/.test(ref) && !ref.includes("..") && !ref.includes("\\");
  },

  validateGitRef(ref: string): void {
    if (!this.isValidGitRef(ref)) {
      throw new Error(`Invalid git ref: "${ref}"`);
    }
  },

  sanitizeGitRef(ref: string): string {
    return ref.replace(/[^a-zA-Z0-9._\/\-]/g, "_");
  }
};
