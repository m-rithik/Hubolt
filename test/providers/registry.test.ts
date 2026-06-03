import { describe, expect, test } from "vitest";
import {
  getLLMProvider,
  listLLMProviders,
  registerLLMProvider
} from "../../src/providers/llm/registry.js";
import {
  getAnalyzerProvider,
  listAnalyzerProviders,
  registerAnalyzerProvider
} from "../../src/providers/analyzers/registry.js";
import type { AnalyzerProvider, LLMProvider } from "../../src/types/providers.js";

const fakeLLM: LLMProvider = {
  name: "fake-llm",
  async review() {
    return [];
  }
};

const fakeAnalyzer: AnalyzerProvider = {
  name: "fake-analyzer",
  async isAvailable() {
    return true;
  },
  async analyze() {
    return [];
  }
};

describe("LLM provider registry", () => {
  test("registers, resolves, and lists a provider", () => {
    registerLLMProvider("fake-llm", () => fakeLLM);

    expect(getLLMProvider("fake-llm", { model: "test" })).toBe(fakeLLM);
    expect(listLLMProviders()).toContain("fake-llm");
  });

  test("throws on an unknown provider", () => {
    expect(() => getLLMProvider("missing", { model: "test" })).toThrow("Unknown LLM provider: missing");
  });
});

describe("analyzer provider registry", () => {
  test("registers, resolves, and lists a provider", () => {
    registerAnalyzerProvider("fake-analyzer", () => fakeAnalyzer);

    expect(getAnalyzerProvider("fake-analyzer")).toBe(fakeAnalyzer);
    expect(listAnalyzerProviders()).toContain("fake-analyzer");
  });

  test("throws on an unknown provider", () => {
    expect(() => getAnalyzerProvider("missing")).toThrow("Unknown analyzer provider: missing");
  });
});
