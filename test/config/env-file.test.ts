import { describe, expect, test } from "vitest";
import { applyEnvUpdates } from "../../src/config/env-file.js";

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
});
