import { describe, expect, test, vi } from "vitest";
import { PatternMatcher } from "../../src/core/patterns.js";

describe("PatternMatcher", () => {
  test("rejects unsafe regexes before executing them", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const matcher = new PatternMatcher();

    expect(matcher.findAllMatches(/^(a+)+$/, "a".repeat(10_000))).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unsafe regex rejected before execution"));

    warn.mockRestore();
  });

  test("does not spin forever on zero-width matches", () => {
    const matcher = new PatternMatcher();

    expect(matcher.findAllMatches(/(?:)/, "abc")).toHaveLength(4);
  });
});
