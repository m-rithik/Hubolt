import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";
import { describe, expect, test } from "vitest";
import { applyEnvUpdates, readEnvFile } from "../../src/config/env-file.js";

describe("applyEnvUpdates", () => {
  test("updates existing keys and preserves comments and other keys", () => {
    const existing = "# secrets\nOPENAI_API_KEY=old\nOTHER=keep\n";
    const result = applyEnvUpdates(existing, { OPENAI_API_KEY: "new" });

    expect(result).toContain("# secrets");
    expect(result).toContain("OPENAI_API_KEY=new");
    expect(result).toContain("OTHER=keep");
    expect(result).not.toContain("OPENAI_API_KEY=old");
  });

  test("appends keys that are not already present", () => {
    const result = applyEnvUpdates("EXISTING=1\n", { HUBOLT_LLM_PROVIDER: "openai" });

    expect(result).toContain("EXISTING=1");
    expect(result).toContain("HUBOLT_LLM_PROVIDER=openai");
  });

  test("writes from empty and ends with a single trailing newline", () => {
    const result = applyEnvUpdates("", { A: "1", B: "2" });

    expect(result).toBe("A=1\nB=2\n");
  });

  test("quotes values with shell metacharacters so the file is safe to source", () => {
    const result = applyEnvUpdates("", {
      MODEL: "gpt-4; echo HACKED",
      HUBOLT_SLACK_WEBHOOK_URL: "https://hooks.slack.com/x?a=1&b=2"
    });

    // No bare, shell-executable assignment.
    expect(result).not.toContain("MODEL=gpt-4; echo HACKED");
    expect(result).toContain("MODEL='gpt-4; echo HACKED'");
    expect(result).toContain("HUBOLT_SLACK_WEBHOOK_URL='https://hooks.slack.com/x?a=1&b=2'");

    // dotenv still loads the original values (quotes stripped).
    expect(dotenv.parse(result)).toMatchObject({
      MODEL: "gpt-4; echo HACKED",
      HUBOLT_SLACK_WEBHOOK_URL: "https://hooks.slack.com/x?a=1&b=2"
    });
  });

  test("leaves simple tokens unquoted", () => {
    expect(applyEnvUpdates("", { A: "openai", B: "gpt-4o-mini" })).toBe("A=openai\nB=gpt-4o-mini\n");
  });

  test("reads existing dotenv values without shell expansion", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubolt-env-file-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(envPath, "HUBOLT_LLM_PROVIDER=google\nGOOGLE_GENERATIVE_AI_API_KEY=test-key\n");

      expect(readEnvFile(envPath)).toEqual({
        HUBOLT_LLM_PROVIDER: "google",
        GOOGLE_GENERATIVE_AI_API_KEY: "test-key"
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
