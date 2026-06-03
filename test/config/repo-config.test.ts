import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadRepoConfig } from "../../src/config/repo-config.js";

describe("repo config", () => {
  test("uses defaults when .hubolt.yml is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubolt-config-"));
    try {
      const loaded = loadRepoConfig({ cwd: dir });

      expect(loaded.path).toBeNull();
      expect(loaded.config.mode).toBe("balanced");
      expect(loaded.config.providers.llm).toBe("openai");
      expect(loaded.config.privacy.redactSecrets).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads valid .hubolt.yml values", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubolt-config-"));
    try {
      writeFileSync(
        join(dir, ".hubolt.yml"),
        [
          "mode: security",
          "severityThreshold: high",
          "providers:",
          "  llm: local",
          "  model: llama",
          ""
        ].join("\n")
      );

      const loaded = loadRepoConfig({ cwd: dir });

      expect(loaded.path).not.toBeNull();
      expect(loaded.config.mode).toBe("security");
      expect(loaded.config.severityThreshold).toBe("high");
      expect(loaded.config.providers.llm).toBe("local");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid mode values", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubolt-config-"));
    try {
      writeFileSync(join(dir, ".hubolt.yml"), "mode: loud\n");

      expect(() => loadRepoConfig({ cwd: dir })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
