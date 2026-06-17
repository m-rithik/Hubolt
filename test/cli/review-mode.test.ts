import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadRepoConfig } from "../../src/config/repo-config.js";
import { writeReviewModeConfig } from "../../src/cli/commands/review.js";

describe("review mode config", () => {
  test("updates the mode in an existing config", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubolt-review-mode-"));
    try {
      const configPath = join(dir, ".hubolt.yml");
      writeFileSync(
        configPath,
        [
          "mode: balanced",
          "severityThreshold: medium",
          "providers:",
          "  llm: openai",
          "  model: gpt-4.1-mini",
          ""
        ].join("\n")
      );

      writeReviewModeConfig(configPath, "strict");

      const loaded = loadRepoConfig({ cwd: dir });
      expect(loaded.config.mode).toBe("strict");
      expect(loaded.config.severityThreshold).toBe("medium");
      expect(loaded.config.providers.model).toBe("gpt-4.1-mini");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates a starter config when the target config is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubolt-review-mode-"));
    try {
      const configPath = join(dir, ".hubolt.yml");

      writeReviewModeConfig(configPath, "quiet");

      expect(existsSync(configPath)).toBe(true);
      const loaded = loadRepoConfig({ cwd: dir });
      expect(loaded.config.mode).toBe("quiet");
      expect(loaded.config.commentBudget).toBe(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid mode values before writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubolt-review-mode-"));
    try {
      const configPath = join(dir, ".hubolt.yml");
      writeFileSync(configPath, "mode: balanced\n");

      expect(() => writeReviewModeConfig(configPath, "loud")).toThrow("Invalid review mode");
      expect(readFileSync(configPath, "utf8")).toBe("mode: balanced\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
