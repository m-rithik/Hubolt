import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PathValidators } from "../../src/core/validators.js";

describe("PathValidators", () => {
  test("accepts paths inside the base directory", () => {
    const base = join(process.cwd(), "src");

    expect(PathValidators.isPathWithin(join(base, "core", "validators.ts"), base)).toBe(true);
    expect(PathValidators.isPathWithin(base, base)).toBe(true);
  });

  test("rejects sibling paths that only share a prefix", () => {
    const base = join(process.cwd(), "src");

    expect(PathValidators.isPathWithin(join(process.cwd(), "src-other", "file.ts"), base)).toBe(false);
  });

  test("rejects paths outside the base directory", () => {
    const base = join(process.cwd(), "src", "core");

    expect(PathValidators.isPathWithin(join(base, "..", "..", "package.json"), base)).toBe(false);
  });
});
