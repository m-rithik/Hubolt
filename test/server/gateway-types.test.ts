import { describe, expect, test } from "vitest";
import { extractActualCost } from "../../src/server/services/types.js";

describe("Type Utilities", () => {
  describe("extractActualCost", () => {
    test("extracts cost from object response", () => {
      const response = {
        findings: [],
        metadata: {
          promptTokens: 10,
          completionTokens: 5,
          estimatedCostUsd: 0.05
        }
      };

      const cost = extractActualCost(response, 0.10);

      expect(cost).toBe(0.05);
    });

    test("extracts cost from JSON string response", () => {
      const response = JSON.stringify({
        findings: [],
        metadata: {
          promptTokens: 10,
          completionTokens: 5,
          estimatedCostUsd: 0.03
        }
      });

      const cost = extractActualCost(response, 0.10);

      expect(cost).toBe(0.03);
    });

    test("returns fallback for invalid JSON string", () => {
      const response = "not valid json";
      const fallback = 0.10;

      const cost = extractActualCost(response, fallback);

      expect(cost).toBe(fallback);
    });

    test("returns fallback for missing metadata", () => {
      const response = {
        findings: []
      };
      const fallback = 0.10;

      const cost = extractActualCost(response, fallback);

      expect(cost).toBe(fallback);
    });

    test("returns fallback for missing estimatedCostUsd", () => {
      const response = {
        findings: [],
        metadata: {
          promptTokens: 10,
          completionTokens: 5
        }
      };
      const fallback = 0.10;

      const cost = extractActualCost(response, fallback);

      expect(cost).toBe(fallback);
    });

    test("returns fallback for negative cost", () => {
      const response = {
        findings: [],
        metadata: {
          promptTokens: 10,
          completionTokens: 5,
          estimatedCostUsd: -0.05
        }
      };
      const fallback = 0.10;

      const cost = extractActualCost(response, fallback);

      expect(cost).toBe(fallback);
    });

    test("returns fallback for non-finite cost", () => {
      const response = {
        findings: [],
        metadata: {
          promptTokens: 10,
          completionTokens: 5,
          estimatedCostUsd: Infinity
        }
      };
      const fallback = 0.10;

      const cost = extractActualCost(response, fallback);

      expect(cost).toBe(fallback);
    });

    test("handles null response", () => {
      const cost = extractActualCost(null, 0.10);
      expect(cost).toBe(0.10);
    });

    test("handles undefined response", () => {
      const cost = extractActualCost(undefined, 0.10);
      expect(cost).toBe(0.10);
    });

    test("handles empty string response", () => {
      const cost = extractActualCost("", 0.10);
      expect(cost).toBe(0.10);
    });
  });
});
