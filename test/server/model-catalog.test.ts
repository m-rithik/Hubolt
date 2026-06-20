import { describe, expect, test } from "vitest";
import { MODEL_CATALOG, getModelInfo } from "../../src/server/services/model-catalog.js";

describe("model catalog", () => {
  test("does not advertise retired Google model IDs", () => {
    const google = MODEL_CATALOG.google;
    // These IDs were shut down by Google; routing to them fails at the provider.
    expect(google["gemini-2.0-flash"]).toBeUndefined();
    expect(google["gemini-1.5-pro"]).toBeUndefined();
  });

  test("offers current Google model IDs as available", () => {
    expect(getModelInfo("google", "gemini-2.5-flash")?.available).toBe(true);
    expect(getModelInfo("google", "gemini-2.5-pro")?.available).toBe(true);
  });
});
