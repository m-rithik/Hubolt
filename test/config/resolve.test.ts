import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveSettings } from "../../src/config/resolve.js";
import { DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER_ID } from "../../src/providers/llm/catalog.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hubolt-resolve-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveSettings precedence", () => {
  test("falls back to built-in defaults", () => {
    const settings = resolveSettings({ cwd: dir, env: {} });

    expect(settings.configPath).toBeNull();
    expect(settings.llmProvider).toBe(DEFAULT_LLM_PROVIDER_ID);
    expect(settings.llmModel).toBe(DEFAULT_LLM_MODEL);
  });

  test(".hubolt.yml overrides defaults", () => {
    writeFileSync(join(dir, ".hubolt.yml"), "providers:\n  llm: local\n  model: llama\n");

    const settings = resolveSettings({ cwd: dir, env: {} });

    expect(settings.configPath).not.toBeNull();
    expect(settings.llmProvider).toBe("local");
    expect(settings.llmModel).toBe("llama");
  });

  test("environment overrides .hubolt.yml", () => {
    writeFileSync(join(dir, ".hubolt.yml"), "providers:\n  llm: local\n  model: llama\n");

    const settings = resolveSettings({
      cwd: dir,
      env: { llmProvider: "anthropic", llmModel: "claude" }
    });

    expect(settings.llmProvider).toBe("anthropic");
    expect(settings.llmModel).toBe("claude");
  });
});
